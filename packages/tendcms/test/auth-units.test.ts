import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { tooManyTries } from "../src/api/errors.ts";
import { clientIp, networkKey, rateLimitKey, storedIpPrefix } from "../src/auth/client-ip.ts";
import { normalizeCrockford, randomCrockford } from "../src/auth/crockford.ts";
import { isForeignRequest } from "../src/auth/csrf.ts";
import { createDeviceCookie, deviceCookieIsValid } from "../src/auth/device-cookie.ts";
import {
  generatePassword,
  hashPassword,
  needsRehash,
  passwordProblem,
  verifyPassword,
} from "../src/auth/passwords.ts";
import { AccountBackoff, TokenBuckets, WorkGate } from "../src/auth/ratelimit.ts";
import { displaySetupCode, setupCodeMatches } from "../src/auth/setup-code.ts";
import { uuidv7 } from "../src/ids.ts";

const context = { email: "tom@example.com", name: "Tom Baker", siteName: "Rise Bakery" };

describe("passwordProblem", () => {
  test.each([
    "maple-river-candle-stone-orbit",
    "correct horse battery",
    "my dog is called Biscuit",
    "ÉtéÀLaPlage2024!",
    "日本語のパスワードです長いです",
  ])("accepts %s", (password) => {
    expect(passwordProblem(password, context)).toBeUndefined();
  });

  test.each([
    ["too short", "short-pass"],
    ["one character", "aaaaaaaaaaaaaaaa"],
    ["a repeated pattern", "abcabcabcabcabc"],
    ["a doubled word", "sunshinesunshine"],
    ["counting", "123456789012"],
    ["counting down", "987654321098"],
    ["the alphabet", "abcdefghijklmnop"],
    ["a keyboard row", "qwertyuiopas"],
    ["a keyboard pattern", "1qaz2wsx3edc"],
    ["a common word and digits", "password1234"],
    ["a common word with letter swaps", "p@ssw0rd2024!"],
    ["a common phrase", "iloveyou12345"],
    ["their email", "tom@example.com"],
    ["their name", "Tom Baker 2024"],
    ["their site's name", "rise bakery 123"],
  ])("rejects %s", (_, password) => {
    expect(passwordProblem(password, context)).toBeTruthy();
  });

  test("counts characters, not bytes, and has an upper limit", () => {
    expect(passwordProblem("🌱".repeat(11), context)).toMatch(/at least 12/);
    expect(passwordProblem("a b".repeat(400), context)).toMatch(/1024 characters or fewer/);
  });
});

describe("password hashing", () => {
  test("hashes with the plan's settings and verifies", async () => {
    const stored = await hashPassword("maple-river-candle");
    expect(stored).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(needsRehash(stored)).toBe(false);
    expect(await verifyPassword(stored, "maple-river-candle")).toBe(true);
    expect(await verifyPassword(stored, "maple-river-candlf")).toBe(false);
  });

  test("a damaged hash is a failed check, not a crash", async () => {
    expect(await verifyPassword("not-a-hash", "anything")).toBe(false);
    expect(needsRehash("not-a-hash")).toBe(true);
  });

  test("generated passwords pass the policy and don't repeat", () => {
    const first = generatePassword();
    expect(first).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/);
    expect(passwordProblem(first, context)).toBeUndefined();
    expect(generatePassword()).not.toBe(first);
  });
});

describe("setup code", () => {
  test("is 8 characters from the safe alphabet, stable for one key, different across keys", () => {
    const key = randomBytes(32);
    const code = displaySetupCode(key);
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(displaySetupCode(key)).toBe(code);
    expect(displaySetupCode(randomBytes(32))).not.toBe(code);
  });

  test("matches the code, and nothing else", () => {
    const secretKey = randomBytes(32);
    const source = { secretKey, setupPassword: undefined };
    expect(setupCodeMatches(displaySetupCode(secretKey), source)).toBe(true);
    expect(setupCodeMatches("", source)).toBe(false);
    expect(setupCodeMatches("AAAA-AAAA", source)).toBe(false);
  });

  test("normalizeCrockford forgives case, spaces, dashes and lookalike letters", () => {
    expect(normalizeCrockford(" ab-c i l o ")).toBe("ABC110");
    expect(randomCrockford(20)).toHaveLength(20);
  });
});

describe("device cookies", () => {
  const key = randomBytes(32);
  const now = 1_800_000_000_000;

  test("are valid for the account they were made for, until they expire", () => {
    const cookie = createDeviceCookie(key, "a@example.com", now);
    expect(deviceCookieIsValid(key, cookie, "a@example.com", now)).toBe(true);
    expect(deviceCookieIsValid(key, cookie, "b@example.com", now)).toBe(false);
    expect(deviceCookieIsValid(key, cookie, "a@example.com", now + 366 * 86_400_000)).toBe(false);
    expect(deviceCookieIsValid(randomBytes(32), cookie, "a@example.com", now)).toBe(false);
  });

  test.each([undefined, "", "a.b.c", "a.b.c.d", "a.b.c.d.e"])("%s isn't valid", (cookie) => {
    expect(deviceCookieIsValid(key, cookie, "a@example.com", now)).toBe(false);
  });

  test("changing the expiry breaks the signature", () => {
    const parts = createDeviceCookie(key, "a@example.com", now).split(".");
    parts[1] = String(now + 10 ** 12);
    expect(deviceCookieIsValid(key, parts.join("."), "a@example.com", now)).toBe(false);
  });
});

describe("TokenBuckets", () => {
  test("allows the burst, then refills over time", () => {
    let time = 0;
    const buckets = new TokenBuckets({ perMinute: 5, now: () => time });
    for (let i = 0; i < 5; i++) expect(buckets.take("k").allowed).toBe(true);
    const blocked = buckets.take("k");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBe(12);
    expect(buckets.take("other").allowed).toBe(true);

    time = 12_000;
    expect(buckets.take("k").allowed).toBe(true);
    expect(buckets.take("k").allowed).toBe(false);
  });

  test("refunds never exceed the capacity", () => {
    const buckets = new TokenBuckets({ perMinute: 2, now: () => 0 });
    buckets.refund("k");
    buckets.refund("k");
    expect(buckets.take("k").allowed).toBe(true);
    expect(buckets.take("k").allowed).toBe(true);
    expect(buckets.take("k").allowed).toBe(false);
  });

  test("a flood of made-up keys can't use unbounded memory", () => {
    const buckets = new TokenBuckets({ perMinute: 1, maxKeys: 2, now: () => 0 });
    buckets.take("a");
    buckets.take("b");
    buckets.take("c");
    // "a" was pushed out, so it starts fresh, while "c" is still spent.
    expect(buckets.take("c").allowed).toBe(false);
    expect(buckets.take("a").allowed).toBe(true);
  });
});

describe("AccountBackoff", () => {
  test("starts after 10 failures, doubles, stops at an hour, and resets", () => {
    let time = 0;
    const backoff = new AccountBackoff({ now: () => time });
    for (let i = 0; i < 9; i++) backoff.recordFailure("k");
    expect(backoff.retryAfterSeconds("k")).toBe(0);
    backoff.recordFailure("k");
    expect(backoff.retryAfterSeconds("k")).toBe(60);
    backoff.recordFailure("k");
    expect(backoff.retryAfterSeconds("k")).toBe(120);
    for (let i = 0; i < 30; i++) backoff.recordFailure("k");
    expect(backoff.retryAfterSeconds("k")).toBe(3600);

    time = 3_600_000;
    expect(backoff.retryAfterSeconds("k")).toBe(0);
    backoff.reset("k");
    backoff.recordFailure("k");
    expect(backoff.retryAfterSeconds("k")).toBe(0);
  });
});

describe("AccountBackoff, over time", () => {
  test("forgets old failures, so one typo long after an attack costs nothing", () => {
    let time = 0;
    const backoff = new AccountBackoff({ now: () => time });
    for (let i = 0; i < 20; i++) backoff.recordFailure("k");
    time += 25 * 3_600_000;
    backoff.recordFailure("k");
    expect(backoff.retryAfterSeconds("k")).toBe(0);
  });

  test("still counts failures close together", () => {
    let time = 0;
    const backoff = new AccountBackoff({ now: () => time });
    for (let i = 0; i < 10; i++) {
      time += 60_000;
      backoff.recordFailure("k");
    }
    expect(backoff.retryAfterSeconds("k")).toBe(60);
  });
});

describe("WorkGate", () => {
  test("lets in up to the limit, and keeps some room for priority work", () => {
    const gate = new WorkGate({ limit: 2, reservedForPriority: 1 });
    expect(gate.tryEnter(false)).toBe(true);
    expect(gate.tryEnter(false)).toBe(true);
    expect(gate.tryEnter(false)).toBe(false);
    expect(gate.tryEnter(true)).toBe(true);
    expect(gate.tryEnter(true)).toBe(false);
    gate.leave();
    gate.leave();
    expect(gate.tryEnter(false)).toBe(true);
  });
});

describe("tooManyTries", () => {
  test.each([
    [1, "1 second."],
    [30, "30 seconds."],
    [120, "2 minutes."],
  ])("%i seconds reads naturally", (seconds, ending) => {
    expect(tooManyTries(seconds).message).toContain(`Try again in ${ending}`);
  });
});

describe("clientIp", () => {
  async function seen(headers: Record<string, string>, trustProxy: number) {
    const app = new Hono();
    app.get("/", (c) => c.text(clientIp(c, trustProxy)));
    return (await app.request("/", { headers })).text();
  }

  test("ignores X-Forwarded-For unless a proxy is trusted", async () => {
    expect(await seen({ "X-Forwarded-For": "6.6.6.6" }, 0)).toBe("unknown");
  });

  test("counts hops from the right, because the left side is written by the client", async () => {
    const forwarded = { "X-Forwarded-For": "6.6.6.6, 1.2.3.4, 10.0.0.1" };
    expect(await seen(forwarded, 1)).toBe("10.0.0.1");
    expect(await seen(forwarded, 2)).toBe("1.2.3.4");
  });

  test("falls back when the header is short or isn't an address", async () => {
    expect(await seen({ "X-Forwarded-For": "1.2.3.4" }, 2)).toBe("unknown");
    expect(await seen({ "X-Forwarded-For": "not-an-ip" }, 1)).toBe("unknown");
    expect(await seen({}, 1)).toBe("unknown");
  });

  test("unwraps IPv4 written as IPv6", async () => {
    expect(await seen({ "X-Forwarded-For": "::ffff:1.2.3.4" }, 1)).toBe("1.2.3.4");
  });
});

describe("address buckets", () => {
  test("all of one IPv6 /64 shares a bucket, however it's written", () => {
    expect(rateLimitKey("2001:db8:1:2:aaaa::1")).toBe("2001:db8:1:2::/64");
    expect(rateLimitKey("2001:db8:1:2:bbbb:cccc:dddd:eeee")).toBe("2001:db8:1:2::/64");
    expect(rateLimitKey("::1")).toBe("0:0:0:0::/64");
    expect(rateLimitKey("2001:db8::")).toBe("2001:db8:0:0::/64");
  });

  test("IPv6 also gets a coarser /48 bucket, and IPv4 doesn't", () => {
    expect(networkKey("2001:db8:1:2:aaaa::1")).toBe("2001:db8:1");
    expect(networkKey("2001:db8:1:ffff::1")).toBe("2001:db8:1");
    expect(networkKey("2001:db8:2::1")).toBe("2001:db8:2");
    expect(networkKey("1.2.3.4")).toBeUndefined();
  });

  test("each IPv4 address has its own bucket", () => {
    expect(rateLimitKey("1.2.3.4")).toBe("1.2.3.4");
  });

  test("sessions store only a coarse prefix", () => {
    expect(storedIpPrefix("1.2.3.4")).toBe("1.2.3.0/24");
    expect(storedIpPrefix("2001:db8:1:2:aaaa::1")).toBe("2001:db8:1:2::/64");
    expect(storedIpPrefix("unknown")).toBeNull();
  });
});

describe("isForeignRequest", () => {
  const base = { secFetchSite: undefined, origin: undefined, host: "a.test", publicUrl: undefined };

  test("trusts Sec-Fetch-Site over Origin when both are present", () => {
    expect(
      isForeignRequest({ ...base, secFetchSite: "same-origin", origin: "https://b.test" }),
    ).toBe(false);
    expect(
      isForeignRequest({ ...base, secFetchSite: "cross-site", origin: "https://a.test" }),
    ).toBe(true);
  });

  test("compares host and port, not just the name", () => {
    expect(isForeignRequest({ ...base, host: "a.test:3000", origin: "http://a.test:3000" })).toBe(
      false,
    );
    expect(isForeignRequest({ ...base, host: "a.test:3000", origin: "http://a.test:4000" })).toBe(
      true,
    );
  });
});

test("uuidv7 is version 7, sorts by time and doesn't repeat", () => {
  const first = uuidv7(1_000);
  const second = uuidv7(2_000);
  expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(first < second).toBe(true);
  expect(uuidv7(1_000)).not.toBe(first);
});
