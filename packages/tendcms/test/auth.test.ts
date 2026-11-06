import { createHash } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import { hashPassword, spendVerifyTime, verifyPassword } from "../src/auth/passwords.ts";
import { resetPasswordAndSignOutEverywhere, upgradePasswordHash } from "../src/db/repo/users.ts";
import {
  browser,
  GOOD_PASSWORD,
  type MadeApp,
  makeApp,
  OWNER_EMAIL,
  type Reply,
  START_TIME,
  setUp,
  setupBody,
} from "./auth-helpers.ts";

vi.mock("../src/auth/passwords.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/auth/passwords.ts")>();
  return {
    ...actual,
    spendVerifyTime: vi.fn(actual.spendVerifyTime),
    verifyPassword: vi.fn(actual.verifyPassword),
  };
});

const DAY = 24 * 60 * 60 * 1000;
const WRONG_PASSWORD = "not-the-right-password";

describe("first-run setup", () => {
  test("says setup is needed, without giving anything else away", async () => {
    const made = await makeApp();
    const reply = await browser(made.app).get("/api/auth/setup/status");
    expect(reply.status).toBe(200);
    expect(await reply.json()).toEqual({ needsSetup: true, codeKind: "code" });
  });

  test("creates the Owner and the site, and signs them in", async () => {
    const made = await makeApp();
    const owner = browser(made.app);

    const reply = await owner.post("/api/auth/setup", { code: made.code, ...setupBody() });
    expect(reply.status).toBe(201);
    const { user } = await reply.json();
    expect(user).toMatchObject({
      name: "Tom Baker",
      email: OWNER_EMAIL,
      isOwner: true,
      role: "admin",
    });
    expect(user).not.toHaveProperty("passwordHash");

    const me = await (await owner.get("/api/auth/me")).json();
    expect(me.user.email).toBe(OWNER_EMAIL);
    expect(me.site).toEqual({ name: "Rise Bakery", tagline: "Fresh bread" });
    expect(me.starter).toBe("business");
    expect(me.siteIsPublic).toBe(false);

    const site = made.db.prepare("SELECT value FROM settings WHERE key = 'site'").get() as {
      value: string;
    };
    expect(JSON.parse(site.value)).toEqual({
      name: "Rise Bakery",
      tagline: "Fresh bread",
      locale: "en-PH",
      timezone: "Asia/Manila",
      address: null,
      address_confirmed: false,
    });
  });

  test("stores an Argon2id hash, never the password", async () => {
    const made = await makeApp();
    await setUp(made);
    const row = made.db.prepare("SELECT password_hash FROM users").get() as {
      password_hash: string;
    };
    expect(row.password_hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await verifyPassword(row.password_hash, GOOD_PASSWORD)).toBe(true);
    const everything = JSON.stringify(made.db.prepare("SELECT * FROM users").all());
    expect(everything).not.toContain(GOOD_PASSWORD);
  });

  test.each([
    ["no code", {}],
    ["a wrong code", { code: "AAAA-AAAA" }],
  ])("refuses %s, and creates nothing", async (_, extra) => {
    const made = await makeApp();
    const reply = await browser(made.app).post("/api/auth/setup", { ...setupBody(), ...extra });
    expect([400, 401]).toContain(reply.status);
    expect(made.db.prepare("SELECT count(*) AS n FROM users").get()).toEqual({ n: 0 });
    expect(reply.cookies).toEqual([]);
  });

  test("a wrong code is rejected before anything else in the request is looked at", async () => {
    const made = await makeApp();
    const reply = await browser(made.app).post("/api/auth/setup", {
      code: "AAAA-AAAA",
      owner: { password: "short" },
    });
    expect(reply.status).toBe(401);
    expect((await reply.json()).error.code).toBe("setup_code_wrong");
  });

  test("forgives how the code was retyped", async () => {
    const made = await makeApp();
    const sloppy = made.code.toLowerCase().replace("-", " ").replace(/1/g, "l").replace(/0/g, "o");
    const reply = await browser(made.app).post("/api/auth/setup/check-code", { code: sloppy });
    expect(reply.status).toBe(204);
  });

  test("closes for good once there's an Owner", async () => {
    const made = await makeApp();
    await setUp(made);
    const stranger = browser(made.app);

    expect(await (await stranger.get("/api/auth/setup/status")).json()).toMatchObject({
      needsSetup: false,
    });
    const check = await stranger.post("/api/auth/setup/check-code", { code: made.code });
    expect(check.status).toBe(409);
    const second = await stranger.post("/api/auth/setup", { code: made.code, ...setupBody() });
    expect(second.status).toBe(409);
    expect((await second.json()).error.code).toBe("setup_closed");
    // Closed comes first: no more code guessing, and no password hashing, for anyone.
    const guess = await stranger.post("/api/auth/setup", { code: "WRONG", ...setupBody() });
    expect(guess.status).toBe(409);
    expect(made.db.prepare("SELECT count(*) AS n FROM users").get()).toEqual({ n: 1 });
  });

  test("two people finishing at the same moment make exactly one Owner", async () => {
    const made = await makeApp();
    const replies = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        browser(made.app).post("/api/auth/setup", {
          code: made.code,
          ...setupBody({
            owner: { name: `P${i}`, email: `p${i}@example.com`, password: GOOD_PASSWORD },
          }),
        }),
      ),
    );
    expect(replies.map((reply) => reply.status).sort()).toEqual([201, 409, 409, 409]);
    expect(made.db.prepare("SELECT count(*) AS n FROM users").get()).toEqual({ n: 1 });
  });

  test("a setup password replaces the code, and is matched exactly", async () => {
    const made = await makeApp({ setupPassword: "My Setup Password" });
    const client = browser(made.app);
    expect(await (await client.get("/api/auth/setup/status")).json()).toMatchObject({
      codeKind: "password",
    });
    expect((await client.post("/api/auth/setup/check-code", { code: made.code })).status).toBe(401);
    expect(
      (await client.post("/api/auth/setup/check-code", { code: "my setup password" })).status,
    ).toBe(401);
    expect(
      (await client.post("/api/auth/setup/check-code", { code: "My Setup Password" })).status,
    ).toBe(204);
  });

  test("a wrong setup password is called a password, not a code", async () => {
    const made = await makeApp({ setupPassword: "My Setup Password" });
    const reply = await browser(made.app).post("/api/auth/setup/check-code", { code: "nope" });
    const { error } = await reply.json();
    expect(error.message).toContain("setup password");
    expect(error.message).not.toContain("setup code");
  });

  test("limits wrong codes to 5 a minute, but right ones don't count", async () => {
    const made = await makeApp();
    const client = browser(made.app);
    for (let i = 0; i < 8; i++) {
      expect((await client.post("/api/auth/setup/check-code", { code: made.code })).status).toBe(
        204,
      );
    }
    for (let i = 0; i < 5; i++) {
      expect((await client.post("/api/auth/setup/check-code", { code: "WRONG" })).status).toBe(401);
    }
    const blocked = await client.post("/api/auth/setup/check-code", { code: made.code });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);

    made.clock.time += 60_000;
    expect((await client.post("/api/auth/setup/check-code", { code: made.code })).status).toBe(204);
  });

  test.each([
    ["an empty site name", { site: { name: "  " } }, "site.name"],
    [
      "an empty owner name",
      { owner: { name: "", email: "a@b.co", password: GOOD_PASSWORD } },
      "owner.name",
    ],
    [
      "a broken email",
      { owner: { name: "A", email: "nope", password: GOOD_PASSWORD } },
      "owner.email",
    ],
    [
      "a short password",
      { owner: { name: "A", email: "a@b.co", password: "short" } },
      "owner.password",
    ],
    [
      "a common password",
      { owner: { name: "A", email: "a@b.co", password: "password1234" } },
      "owner.password",
    ],
    [
      "their own email as the password",
      {
        owner: { name: "A", email: "tomthebaker@example.com", password: "tomthebaker@example.com" },
      },
      "owner.password",
    ],
    ["an unknown starting point", { starter: "wiki" }, "starter"],
  ])("explains %s and names the field", async (_, overrides, field) => {
    const made = await makeApp();
    const reply = await browser(made.app).post("/api/auth/setup", {
      code: made.code,
      ...setupBody(overrides),
    });
    expect(reply.status).toBe(400);
    const { error } = await reply.json();
    expect(error.field).toBe(field);
    expect(error.message.length).toBeGreaterThan(0);
    expect(error.docs).toContain("https://tendcms.dev/errors/");
    expect(made.db.prepare("SELECT count(*) AS n FROM users").get()).toEqual({ n: 0 });
  });

  test("bad language or timezone from the browser falls back instead of stopping setup", async () => {
    const made = await makeApp();
    const owner = browser(made.app);
    const reply = await owner.post("/api/auth/setup", {
      code: made.code,
      ...setupBody({ site: { name: "X Y", locale: "!!", timezone: "Mars/Olympus" } }),
    });
    expect(reply.status).toBe(201);
    const site = made.db.prepare("SELECT value FROM settings WHERE key = 'site'").get() as {
      value: string;
    };
    expect(JSON.parse(site.value)).toMatchObject({ locale: "en", timezone: "UTC", tagline: "" });
  });
});

describe("signing in", () => {
  async function signedOut() {
    const made = await makeApp();
    await setUp(made);
    return { ...made, client: browser(made.app) };
  }

  test("works with the right password, in any email case", async () => {
    const { client } = await signedOut();
    const reply = await client.post("/api/auth/login", {
      email: " TOM@example.COM ",
      password: GOOD_PASSWORD,
    });
    expect(reply.status).toBe(200);
    expect((await reply.json()).user.email).toBe(OWNER_EMAIL);
    expect((await client.get("/api/auth/me")).status).toBe(200);
  });

  test("a wrong password and an unknown email get exactly the same answer", async () => {
    const { client } = await signedOut();
    const wrong = await client.post("/api/auth/login", {
      email: OWNER_EMAIL,
      password: WRONG_PASSWORD,
    });
    const unknown = await client.post("/api/auth/login", {
      email: "nobody@example.com",
      password: WRONG_PASSWORD,
    });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(await wrong.json()).toEqual(await unknown.json());
    expect(wrong.cookies).toEqual([]);
    expect((await client.get("/api/auth/me")).status).toBe(401);
  });

  test("takes as long for an unknown email as for a real one", async () => {
    const { client } = await signedOut();
    vi.mocked(spendVerifyTime).mockClear();
    await client.post("/api/auth/login", { email: OWNER_EMAIL, password: WRONG_PASSWORD });
    expect(spendVerifyTime).not.toHaveBeenCalled();
    await client.post("/api/auth/login", { email: "nobody@example.com", password: WRONG_PASSWORD });
    expect(spendVerifyTime).toHaveBeenCalledTimes(1);
  });

  test("a disabled account can't sign in, and its open sessions stop working", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    made.db.prepare("UPDATE users SET disabled_at = 1").run();
    expect((await owner.get("/api/auth/me")).status).toBe(401);
    const reply = await browser(made.app).post("/api/auth/login", {
      email: OWNER_EMAIL,
      password: GOOD_PASSWORD,
    });
    expect(reply.status).toBe(401);
  });

  test("limits guesses to 5 a minute per account and address, however fast they arrive", async () => {
    const { client } = await signedOut();
    const replies = await Promise.all(
      Array.from({ length: 8 }, () =>
        client.post("/api/auth/login", { email: OWNER_EMAIL, password: WRONG_PASSWORD }),
      ),
    );
    const statuses = replies.map((reply) => reply.status).sort();
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429, 429, 429]);
    const blocked = replies.find((reply) => reply.status === 429) as Reply;
    expect(blocked.headers.get("retry-after")).toBeTruthy();
    expect((await blocked.json()).error.code).toBe("too_many_tries");
  });

  test("successful sign-ins don't use up the limit", async () => {
    const { client } = await signedOut();
    for (let i = 0; i < 8; i++) {
      const reply = await client.post("/api/auth/login", {
        email: OWNER_EMAIL,
        password: GOOD_PASSWORD,
      });
      expect(reply.status).toBe(200);
    }
  });

  test("one address can't work through many accounts quickly", async () => {
    const { client } = await signedOut();
    const statuses: number[] = [];
    for (let i = 0; i < 25; i++) {
      const reply = await client.post("/api/auth/login", {
        email: `person${i}@example.com`,
        password: WRONG_PASSWORD,
      });
      statuses.push(reply.status);
    }
    expect(statuses.filter((status) => status === 401)).toHaveLength(20);
    expect(statuses.filter((status) => status === 429)).toHaveLength(5);
  });

  /** Spaces guesses out so only the per-account backoff can be what stops them. */
  async function failFromNewDevices(made: MadeApp, times: number) {
    for (let i = 0; i < times; i++) {
      const reply = await browser(made.app).post("/api/auth/login", {
        email: OWNER_EMAIL,
        password: WRONG_PASSWORD,
      });
      expect(reply.status).toBe(401);
      made.clock.time += 15_000;
    }
  }

  test("unknown devices back off after 10 failures, doubling from a minute", async () => {
    const made = await makeApp();
    await setUp(made);
    await failFromNewDevices(made, 10);
    made.clock.time -= 15_000;

    const attempt = () =>
      browser(made.app).post("/api/auth/login", { email: OWNER_EMAIL, password: GOOD_PASSWORD });
    const blocked = await attempt();
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeLessThanOrEqual(60);

    made.clock.time += 61_000;
    expect((await attempt()).status).toBe(200);
  });

  test("a device that has signed in before isn't locked out by someone else's guesses", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    await owner.post("/api/auth/logout");
    await failFromNewDevices(made, 10);

    const stranger = await browser(made.app).post("/api/auth/login", {
      email: OWNER_EMAIL,
      password: GOOD_PASSWORD,
    });
    expect(stranger.status).toBe(429);

    const mine = await owner.post("/api/auth/login", {
      email: OWNER_EMAIL,
      password: GOOD_PASSWORD,
    });
    expect(mine.status).toBe(200);
  });

  test("a device cookie from another account or a forged one earns no trust", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    await failFromNewDevices(made, 10);
    const cookie = owner.jar.get("tend_device") as string;
    const client = browser(made.app);

    client.jar.set("tend_device", `${cookie.slice(0, -2)}xx`);
    expect(
      (await client.post("/api/auth/login", { email: OWNER_EMAIL, password: GOOD_PASSWORD }))
        .status,
    ).toBe(429);
  });

  test("upgrades an old password hash at the next sign-in", async () => {
    const { client, db } = await signedOut();
    const { hash } = await import("@node-rs/argon2");
    db.prepare("UPDATE users SET password_hash = ?").run(
      await hash(GOOD_PASSWORD, { memoryCost: 4096, timeCost: 3, parallelism: 1 }),
    );

    const reply = await client.post("/api/auth/login", {
      email: OWNER_EMAIL,
      password: GOOD_PASSWORD,
    });
    expect(reply.status).toBe(200);
    const row = db.prepare("SELECT password_hash FROM users").get() as { password_hash: string };
    expect(row.password_hash).toContain("m=19456,t=2,p=1");
    expect(await verifyPassword(row.password_hash, GOOD_PASSWORD)).toBe(true);
  });

  test("accented passwords work whichever way a device encodes them", async () => {
    const made = await makeApp();
    const password = "café-river-candle-stone";
    await browser(made.app).post("/api/auth/setup", {
      code: made.code,
      ...setupBody({ owner: { name: "T", email: OWNER_EMAIL, password } }),
    });
    const reply = await browser(made.app).post("/api/auth/login", {
      email: OWNER_EMAIL,
      password: password.normalize("NFD"),
    });
    expect(reply.status).toBe(200);
  });
});

describe("sign-in against a determined attacker", () => {
  const NEW_PASSWORD = "new-river-candle-pass";

  async function ownerId(made: MadeApp): Promise<string> {
    return (made.db.prepare("SELECT id FROM users").get() as { id: string }).id;
  }

  /** A guess from a different address each time, so only the account's own limits apply. */
  function guess(made: MadeApp, from: string, password = WRONG_PASSWORD, email = OWNER_EMAIL) {
    return browser(made.app).post(
      "/api/auth/login",
      { email, password },
      { "X-Forwarded-For": from },
    );
  }

  async function lockOwner(made: MadeApp): Promise<void> {
    for (let i = 0; i < 10; i++) {
      expect((await guess(made, `198.51.100.${i}`)).status).toBe(401);
    }
    expect((await guess(made, "198.51.100.200", GOOD_PASSWORD)).status).toBe(429);
  }

  test("a reset landing during the password check wins: no session survives it", async () => {
    const made = await makeApp();
    await setUp(made);
    made.db.exec("DELETE FROM sessions");
    const newHash = await hashPassword(NEW_PASSWORD);
    const id = await ownerId(made);

    const { verifyPassword: realVerify } = await vi.importActual<
      typeof import("../src/auth/passwords.ts")
    >("../src/auth/passwords.ts");
    vi.mocked(verifyPassword).mockImplementationOnce(async (stored, password) => {
      const result = await realVerify(stored, password);
      await resetPasswordAndSignOutEverywhere(made.orm, id, newHash, made.clock.time);
      return result;
    });

    const thief = browser(made.app);
    const reply = await thief.post("/api/auth/login", {
      email: OWNER_EMAIL,
      password: GOOD_PASSWORD,
    });
    expect(reply.status).toBe(401);
    expect(thief.jar.has("tend_session")).toBe(false);
    expect(made.db.prepare("SELECT count(*) AS n FROM sessions").get()).toEqual({ n: 0 });
  });

  test("upgrading a hash can't undo a reset that happened in between", async () => {
    const made = await makeApp();
    await setUp(made);
    const id = await ownerId(made);
    const { password_hash: oldHash } = made.db.prepare("SELECT password_hash FROM users").get() as {
      password_hash: string;
    };
    const resetHash = await hashPassword(NEW_PASSWORD);
    await resetPasswordAndSignOutEverywhere(made.orm, id, resetHash, made.clock.time);

    await upgradePasswordHash(made.orm, id, oldHash, await hashPassword(GOOD_PASSWORD));

    expect(made.db.prepare("SELECT password_hash FROM users").get()).toEqual({
      password_hash: resetHash,
    });
  });

  test("guesses arriving in parallel can't get past the lockout", async () => {
    const made = await makeApp({ trustProxy: 1 });
    await setUp(made);
    const statuses: number[] = [];
    for (let batch = 0; batch < 2; batch++) {
      const replies = await Promise.all(
        Array.from({ length: 6 }, (_, i) => guess(made, `198.51.100.${batch * 10 + i}`)),
      );
      statuses.push(...replies.map((reply) => reply.status));
    }
    expect(statuses.filter((status) => status === 401)).toHaveLength(10);
    expect(statuses.filter((status) => status === 429)).toHaveLength(2);
  });

  test("made-up emails can't push a real account's lockout out of memory", async () => {
    const made = await makeApp({ trustProxy: 1, unknownEmailKeys: 2 });
    await setUp(made);
    await lockOwner(made);
    for (let i = 0; i < 6; i++) {
      await guess(made, `203.0.113.${i}`, WRONG_PASSWORD, `made-up-${i}@example.com`);
    }
    expect((await guess(made, "203.0.113.200", GOOD_PASSWORD)).status).toBe(429);
  });

  test("made-up emails lock the same way real ones do, so a lockout reveals nothing", async () => {
    const made = await makeApp({ trustProxy: 1 });
    await setUp(made);
    const email = "nobody@example.com";
    for (let i = 0; i < 10; i++) {
      expect((await guess(made, `198.51.100.${i}`, WRONG_PASSWORD, email)).status).toBe(401);
    }
    expect((await guess(made, "198.51.100.200", WRONG_PASSWORD, email)).status).toBe(429);
  });

  test("a reset lifts the lockout, and guessing can't bring it back for a day", async () => {
    const made = await makeApp({ trustProxy: 1 });
    await setUp(made);
    await lockOwner(made);
    await resetPasswordAndSignOutEverywhere(
      made.orm,
      await ownerId(made),
      await hashPassword(NEW_PASSWORD),
      made.clock.time,
    );

    for (let i = 0; i < 12; i++) {
      expect((await guess(made, `203.0.113.${i}`)).status).toBe(401);
    }
    expect((await guess(made, "203.0.113.200", NEW_PASSWORD)).status).toBe(200);

    made.clock.time += DAY + 1;
    for (let i = 0; i < 10; i++) {
      expect((await guess(made, `192.0.2.${i}`)).status).toBe(401);
    }
    expect((await guess(made, "192.0.2.200", NEW_PASSWORD)).status).toBe(429);
  });

  test("a known device gets limited guesses too, then counts as unknown", async () => {
    const made = await makeApp({ trustProxy: 1 });
    const owner = await setUp(made);
    const device = owner.jar.get("tend_device") as string;
    const fromDevice = (from: string, password = WRONG_PASSWORD) => {
      const client = browser(made.app);
      client.jar.set("tend_device", device);
      return client.post(
        "/api/auth/login",
        { email: OWNER_EMAIL, password },
        { "X-Forwarded-For": from },
      );
    };

    for (let i = 0; i < 10; i++) {
      expect((await fromDevice(`198.51.100.${i}`)).status).toBe(401);
    }
    // Now it's an unknown device: these count against the account, which then locks.
    for (let i = 0; i < 10; i++) {
      expect((await fromDevice(`203.0.113.${i}`)).status).toBe(401);
    }
    expect((await fromDevice("203.0.113.200", GOOD_PASSWORD)).status).toBe(429);
  });

  // Attempts are counted before the password is checked, so all of these depend on a
  // correct sign-in undoing its count. If it didn't, honest people would slowly lock out.
  test("signing in correctly many times never adds up to a lockout", async () => {
    const made = await makeApp({ trustProxy: 1 });
    await setUp(made);
    for (let i = 0; i < 14; i++) {
      expect((await guess(made, `198.51.100.${i}`, GOOD_PASSWORD)).status).toBe(200);
    }
    expect((await guess(made, "198.51.100.200", WRONG_PASSWORD)).status).toBe(401);
  });

  test("a known device stays known however often it signs in", async () => {
    const made = await makeApp({ trustProxy: 1 });
    const owner = await setUp(made);
    for (let i = 0; i < 14; i++) {
      const reply = await owner.post("/api/auth/login", {
        email: OWNER_EMAIL,
        password: GOOD_PASSWORD,
      });
      expect(reply.status).toBe(200);
    }
    await lockOwner(made);
    const reply = await owner.post("/api/auth/login", {
      email: OWNER_EMAIL,
      password: GOOD_PASSWORD,
    });
    expect(reply.status).toBe(200);
  });

  test("correct sign-ins don't use up an IPv6 allocation's shared limit", async () => {
    const made = await makeApp({ trustProxy: 1 });
    await setUp(made);
    for (let i = 0; i < 125; i++) {
      const from = `2001:db8:1:${i.toString(16)}::1`;
      const reply = await guess(made, from, GOOD_PASSWORD);
      expect(reply.status).toBe(200);
    }
  }, 60_000);

  test("only a few password checks run at once, and the rest are told to wait", async () => {
    const made = await makeApp();
    await setUp(made);
    const replies = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        browser(made.app).post("/api/auth/login", {
          email: `person${i}@example.com`,
          password: WRONG_PASSWORD,
        }),
      ),
    );
    expect(replies.filter((reply) => reply.status === 401)).toHaveLength(6);
    const busy = replies.filter((reply) => reply.status === 429);
    expect(busy).toHaveLength(14);
    expect((await (busy[0] as Reply).json()).error.code).toBe("busy");
    expect((busy[0] as Reply).headers.get("retry-after")).toBe("5");
  });

  test("a flood of checks can't keep a known device out", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const flood = Array.from({ length: 10 }, (_, i) =>
      browser(made.app).post("/api/auth/login", {
        email: `person${i}@example.com`,
        password: WRONG_PASSWORD,
      }),
    );
    const mine = await owner.post("/api/auth/login", {
      email: OWNER_EMAIL,
      password: GOOD_PASSWORD,
    });
    const others = await Promise.all(flood);
    expect(others.some((reply) => reply.status === 429)).toBe(true);
    expect(mine.status).toBe(200);
  });

  test("all the /64s in one IPv6 allocation share a limit as well", async () => {
    const made = await makeApp({ trustProxy: 1 });
    await setUp(made);
    const replies = await Promise.all(
      Array.from({ length: 125 }, (_, i) =>
        guess(made, `2001:db8:1:${i.toString(16)}::1`, WRONG_PASSWORD, `p${i}@example.com`),
      ),
    );
    const codes = await Promise.all(
      replies
        .filter((reply) => reply.status === 429)
        .map(async (reply) => (await reply.json()).error.code),
    );
    expect(codes.filter((code) => code === "too_many_tries")).toHaveLength(5);
  });

  test("a proxy that isn't declared gets one clear warning", async () => {
    const made = await makeApp();
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = browser(made.app);
    await client.get("/api/auth/setup/status");
    expect(warned).not.toHaveBeenCalled();
    await client.get("/api/auth/setup/status", { "X-Forwarded-For": "1.2.3.4" });
    await client.get("/api/auth/setup/status", { "X-Forwarded-For": "1.2.3.4" });
    expect(warned).toHaveBeenCalledTimes(1);
    expect(warned.mock.calls[0]?.[0]).toContain("TEND_TRUST_PROXY");
    warned.mockRestore();
  });

  test("a visitor hanging up mid-request isn't logged as a problem", async () => {
    const made = await makeApp();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const body = new ReadableStream({
      start(controller) {
        controller.error(Object.assign(new Error("aborted"), { code: "ECONNRESET" }));
      },
    });
    const reply = await made.app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      duplex: "half",
    } as RequestInit);
    expect(reply.status).toBe(400);
    expect(logged).not.toHaveBeenCalled();
    logged.mockRestore();
  });
});

describe("sessions", () => {
  test("the database only ever holds a hash of the token", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const token = owner.jar.get("tend_session") as string;
    const row = made.db.prepare("SELECT id FROM sessions").get() as { id: string };
    expect(row.id).toBe(createHash("sha256").update(token).digest("hex"));
    expect(row.id).not.toContain(token);
  });

  test("local cookies are HttpOnly and Lax, but not Secure", async () => {
    const made = await makeApp();
    const reply = await browser(made.app).post("/api/auth/setup", {
      code: made.code,
      ...setupBody(),
    });
    const session = reply.cookies.find((line) => line.startsWith("tend_session="));
    expect(session).toMatch(/HttpOnly/i);
    expect(session).toMatch(/SameSite=Lax/i);
    expect(session).toMatch(/Path=\//i);
    expect(session).not.toMatch(/Secure/i);
  });

  test("https sites use __Host- cookies, whatever the request headers claim", async () => {
    const made = await makeApp({ secureCookies: true });
    const reply = await browser(made.app).post(
      "/api/auth/setup",
      { code: made.code, ...setupBody() },
      { "X-Forwarded-Proto": "http" },
    );
    for (const name of ["__Host-tend_session=", "__Host-tend_device="]) {
      const cookie = reply.cookies.find((line) => line.startsWith(name));
      expect(cookie).toMatch(/Secure/i);
      expect(cookie).toMatch(/Path=\//i);
      expect(cookie).not.toMatch(/Domain=/i);
    }
    expect(reply.headers.get("strict-transport-security")).toContain("max-age=");
  });

  test("a made-up token gets nowhere", async () => {
    const made = await makeApp();
    await setUp(made);
    const client = browser(made.app);
    client.jar.set("tend_session", "made-up-token");
    expect((await client.get("/api/auth/me")).status).toBe(401);
  });

  test("expires after 14 days without use", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    made.clock.time = START_TIME + 14 * DAY + 1;
    expect((await owner.get("/api/auth/me")).status).toBe(401);
  });

  test("keeps going while in use, up to 60 days, then stops regardless", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    for (let day = 10; day < 60; day += 10) {
      made.clock.time = START_TIME + day * DAY;
      expect((await owner.get("/api/auth/me")).status).toBe(200);
    }
    made.clock.time = START_TIME + 60 * DAY + 1;
    expect((await owner.get("/api/auth/me")).status).toBe(401);
  });

  test("signing in again replaces the old token", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const before = owner.jar.get("tend_session") as string;
    await owner.post("/api/auth/login", { email: OWNER_EMAIL, password: GOOD_PASSWORD });
    expect(owner.jar.get("tend_session")).not.toBe(before);

    const old = browser(made.app);
    old.jar.set("tend_session", before);
    expect((await old.get("/api/auth/me")).status).toBe(401);
  });

  test("signing out ends that session only, and keeps the device known", async () => {
    const made = await makeApp();
    const laptop = await setUp(made);
    const phone = browser(made.app);
    await phone.post("/api/auth/login", { email: OWNER_EMAIL, password: GOOD_PASSWORD });

    const stolen = laptop.jar.get("tend_session") as string;
    const reply = await laptop.post("/api/auth/logout");
    expect(reply.status).toBe(204);
    expect(laptop.jar.has("tend_session")).toBe(false);
    expect(laptop.jar.has("tend_device")).toBe(true);
    expect((await laptop.get("/api/auth/me")).status).toBe(401);
    expect((await phone.get("/api/auth/me")).status).toBe(200);

    // The token itself must be dead, not just forgotten: a stolen copy stops working too.
    const thief = browser(made.app);
    thief.jar.set("tend_session", stolen);
    expect((await thief.get("/api/auth/me")).status).toBe(401);
  });

  test("signing out when already signed out is fine", async () => {
    const made = await makeApp();
    expect((await browser(made.app).post("/api/auth/logout")).status).toBe(204);
  });

  test("signing out everywhere ends every session", async () => {
    const made = await makeApp();
    const laptop = await setUp(made);
    const phone = browser(made.app);
    await phone.post("/api/auth/login", { email: OWNER_EMAIL, password: GOOD_PASSWORD });

    expect((await laptop.post("/api/auth/logout-all")).status).toBe(204);
    expect((await laptop.get("/api/auth/me")).status).toBe(401);
    expect((await phone.get("/api/auth/me")).status).toBe(401);
    expect(made.db.prepare("SELECT count(*) AS n FROM sessions").get()).toEqual({ n: 0 });
  });

  test("a new password ends every session", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const { id } = made.db.prepare("SELECT id FROM users").get() as { id: string };
    await resetPasswordAndSignOutEverywhere(
      made.orm,
      id,
      await hashPassword("new-river-candle-pass"),
      made.clock.time,
    );
    expect((await owner.get("/api/auth/me")).status).toBe(401);
  });

  test("/me needs a session", async () => {
    const made = await makeApp();
    const reply = await browser(made.app).get("/api/auth/me");
    expect(reply.status).toBe(401);
    expect((await reply.json()).error.code).toBe("not_signed_in");
  });
});

describe("protecting the API", () => {
  test.each([
    ["another site", { "Sec-Fetch-Site": "cross-site" }],
    ["a sibling site on the same domain", { "Sec-Fetch-Site": "same-site" }],
    ["another origin, on plain http", { Origin: "https://evil.example", Host: "localhost:3000" }],
    ["a null origin", { Origin: "null", Host: "localhost:3000" }],
    ["an unreadable origin", { Origin: "not a url", Host: "localhost:3000" }],
  ])("refuses requests from %s", async (_, headers) => {
    const made = await makeApp();
    const reply = await browser(made.app).post(
      "/api/auth/setup",
      { code: made.code, ...setupBody() },
      headers,
    );
    expect(reply.status).toBe(403);
    const { error } = await reply.json();
    expect(error.code).toBe("foreign_request");
    expect(error.fix).toContain("TEND_PUBLIC_URL");
    expect(made.db.prepare("SELECT count(*) AS n FROM users").get()).toEqual({ n: 0 });
  });

  test.each([
    ["the same origin", { "Sec-Fetch-Site": "same-origin" }],
    [
      "a matching Origin, on plain http",
      { Origin: "http://localhost:3000", Host: "localhost:3000" },
    ],
    ["no browser headers at all", {}],
  ])("allows requests from %s", async (_, headers) => {
    const made = await makeApp();
    const reply = await browser(made.app).post(
      "/api/auth/setup/check-code",
      { code: made.code },
      headers,
    );
    expect(reply.status).toBe(204);
  });

  test("the site's public address counts as its own origin behind a proxy", async () => {
    const made = await makeApp({ publicUrl: "https://example.com" });
    const reply = await browser(made.app).post(
      "/api/auth/setup/check-code",
      { code: made.code },
      { Origin: "https://example.com", Host: "tend:3000" },
    );
    expect(reply.status).toBe(204);
  });

  test("anything that isn't JSON is refused, which stops plain HTML forms", async () => {
    const made = await makeApp();
    const reply = await made.app.request("/api/auth/setup/check-code", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "code=x",
    });
    expect(reply.status).toBe(415);
  });

  test("unreadable JSON gets a plain answer", async () => {
    const made = await makeApp();
    const reply = await made.app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(reply.status).toBe(400);
    expect(await reply.json()).toMatchObject({ error: { code: "unreadable_request" } });
  });

  test("oversized requests are refused", async () => {
    const made = await makeApp();
    const reply = await made.app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "a@b.co", password: "x".repeat(70_000) }),
    });
    expect(reply.status).toBe(413);
  });

  test("API answers are never cached, and unknown paths are a JSON 404", async () => {
    const made = await makeApp();
    const client = browser(made.app);
    expect((await client.get("/api/auth/setup/status")).headers.get("cache-control")).toBe(
      "no-store",
    );
    const missing = await client.get("/api/nothing-here");
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe("not_found");
  });

  test("an unexpected failure doesn't leak details", async () => {
    const made = await makeApp();
    const client = browser(made.app);
    made.db.exec("DROP TABLE settings");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const reply = await client.post("/api/auth/setup", { code: made.code, ...setupBody() });
    expect(reply.status).toBe(500);
    const text = JSON.stringify(await reply.json());
    expect(text).not.toMatch(/settings|sqlite|\.ts/i);
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });
});
