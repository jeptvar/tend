import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, test } from "vitest";
import { defaultThemeDir } from "../src/paths.ts";
import { readableOn } from "../src/site/color.ts";
import { darkAccent } from "../src/site/router.ts";
import { type MadeApp, makeApp, setUp } from "./auth-helpers.ts";
import { type Color, color, everyAccent, meadowColors, over, ratio } from "./meadow-colors.ts";

// Meadow itself: that its words can be read whatever colour its owner likes, that a homepage
// opens the way it should, and that its fonts are its own.

type Client = Awaited<ReturnType<typeof setUp>>;

const text = (value: string) => ({ type: "text", text: value });
const paragraph = (value: string) => ({ type: "paragraph", content: [text(value)] });
const heading = (value: string) => ({
  type: "heading",
  attrs: { level: 2 },
  content: [text(value)],
});
const section = (kind: string, content: unknown[], preset = "1", tone = "none") => ({
  type: "section",
  attrs: { kind, preset, tone, align: "left" },
  content,
});

async function html(made: MadeApp, path: string): Promise<string> {
  const reply = await made.app.request(`http://rise.example.com${path}`);
  expect(reply.status, path).toBe(200);
  return reply.text();
}

async function upload(owner: Client, name = "Loaves.png") {
  const data = await sharp({
    create: { width: 2000, height: 1200, channels: 3, background: "#884422" },
  })
    .png()
    .toBuffer();
  const reply = await owner.upload("/api/admin/media", data, name);
  expect(reply.status).toBe(201);
  return (await reply.json()).id as string;
}

async function design(owner: Client, theme: Record<string, string>, more: object = {}) {
  const { value } = await (await owner.get("/api/admin/design")).json();
  const saved = await owner.put("/api/admin/design", {
    ...value,
    ...more,
    theme: { ...value.theme, ...theme },
  });
  expect(saved.status).toBe(200);
}

/** Publishes the homepage with these blocks. */
async function publishHome(owner: Client, content: unknown[]) {
  const { entries } = await (await owner.get("/api/admin/entries?type=page")).json();
  const { id, rev } = entries.find((entry: { isHome: boolean }) => entry.isHome);
  const saved = await owner.patch(
    `/api/admin/entries/${id}`,
    { doc: { type: "doc", content } },
    { "If-Match": String(rev) },
  );
  expect(saved.status).toBe(200);
  const published = await owner.post(
    `/api/admin/entries/${id}/publish`,
    {},
    { "If-Match": String((await saved.json()).rev) },
  );
  expect(published.status).toBe(200);
}

const BUSINESS = {
  address: "12 Mabini Street\nPoblacion, Makati",
  phone: "+63 2 8555 0100",
  email: "hello@risebakery.example",
  mapUrl: "https://maps.example.com/rise",
  hours: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((day) => ({
    day,
    closed: day === "mon",
    opens: "07:00",
    closes: day === "sun" ? "13:00" : "18:00",
  })),
  hoursNote: "Closed on public holidays",
};

describe("its colours", () => {
  /** What's written on what, and the contrast it needs: 3 for signs and rings, 4.5 for words. */
  const WRITTEN: [string, string, number][] = [
    ["ink", "paper", 4.5],
    ["ink", "tint", 4.5],
    ["ink", "tint-strong", 4.5],
    ["ink", "card", 4.5],
    ["muted", "paper", 4.5],
    ["muted", "tint", 4.5],
    ["muted", "card", 4.5],
    ["link", "paper", 4.5],
    ["link", "tint", 4.5],
    ["link", "card", 4.5],
    ["on-accent", "accent", 4.5],
    ["on-band", "band", 4.5],
    ["band-button", "on-band", 4.5],
    ["on-foot", "foot", 4.5],
    ["link", "tint-strong", 3],
    ["accent", "paper", 3],
    ["accent", "card", 3],
    ["accent", "tint", 3],
  ];
  /** How much of the veil there is wherever there are words: theme.css says 70% of it. */
  const VEIL = 0.7;

  test.each(["light", "dark"] as const)(
    "can be told apart in %s mode, whatever the accent",
    (scheme) => {
      const failing: string[] = [];
      for (const chosen of everyAccent()) {
        // Design offers a readable version of one that isn't. In dark mode Tend makes it one.
        const accent =
          scheme === "dark" ? darkAccent(chosen) : readableOn(chosen, ["#ffffff", "#f1f2f2"]);
        const colors = meadowColors(scheme, accent);
        for (const [words, behind, needed] of WRITTEN) {
          const found = ratio(colors[words] as Color, colors[behind] as Color);
          if (found < needed) {
            failing.push(`${accent}: ${words} on ${behind} is ${found.toFixed(2)}`);
          }
        }
        for (const photo of [color("#ffffff"), color("#000000")]) {
          for (const [words, veil] of [
            [colors.ink, colors.paper],
            [colors.ink, colors.tint],
            [color("#fffdf9"), colors.veil],
          ] as [Color, Color][]) {
            const found = ratio(words, over(veil, photo, VEIL));
            if (found < 4.5) failing.push(`${accent}: words on a photo are ${found.toFixed(2)}`);
          }
        }
      }
      expect(failing.length, failing.slice(0, 5).join("; ")).toBe(0);
    },
  );

  test("are the ones its stylesheet uses, and the veil is as thick as they need", () => {
    const css = readFileSync(join(defaultThemeDir, "assets", "theme.css"), "utf8");
    for (const [words, behind] of WRITTEN) {
      for (const name of [words, behind]) expect(css).toContain(`--tend-${name}:`);
    }
    const stops = [
      ...css.matchAll(/color-mix\(in oklab, var\(--t-veil\) (\d+)%, transparent\)([^,;\n]*)/g),
    ].map(([, share, at]) => ({ share: Number(share) / 100, at: (at as string).trim() }));
    // It's as thick as words need up to where they end, and only past there thinner: after
    // --t-end on a wide screen, and at the very top of the photo on a phone.
    const covering = stops.filter(
      ({ share, at }) => !at.includes("var(--t-end) +") && !(share < 0.1 && at === ""),
    );
    expect(covering.length).toBeGreaterThanOrEqual(6);
    for (const { share, at } of covering) expect(share, at).toBeGreaterThanOrEqual(VEIL);
  });
});

describe("a homepage that opens with a Big intro", () => {
  const intro = section("intro", [heading("Bread that takes its time"), paragraph("Since 1987.")]);

  test("shows the business details right after it, and its own title only to screen readers", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    await publishHome(owner, [
      intro,
      paragraph("We bake at night."),
      section("contact", [heading("Come by")]),
      paragraph("The very end."),
    ]);
    const without = await html(made, "/");
    expect(without).not.toContain("t-glance");
    expect(without).toContain('<h1 class="t-hidden">Rise Bakery</h1>');

    await owner.put("/api/admin/settings/business", BUSINESS);
    const page = await html(made, "/");
    const order = [
      "Bread that takes its time",
      'class="t-glance"',
      "We bake at night.",
      "Come by",
      'class="t-business"',
      "The very end.",
    ].map((part) => page.indexOf(part));
    expect(order.every((at) => at > 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // Every section is closed where it was, so what comes after isn't inside it.
    const main = page.slice(page.indexOf("<main"), page.indexOf("</main>"));
    expect(main.match(/<section/g)).toHaveLength(2);
    expect(main.match(/<\/section>/g)).toHaveLength(2);
    const glance = main.slice(main.indexOf("t-glance"), main.indexOf("We bake"));
    for (const part of [
      "7:00",
      "6:00",
      "1:00",
      "12 Mabini Street, Poblacion",
      "tel:+63285550100",
    ]) {
      expect(glance).toContain(part);
    }
    expect(glance).not.toContain("Closed");
  });

  test.each([
    ["a section last", [section("contact", [heading("Come by")])]],
    ["nothing else", []],
    ["words only", [paragraph("The end.")]],
  ])("ends as it should with %s after it", async (_, rest) => {
    const made = await makeApp();
    const owner = await setUp(made);
    await owner.put("/api/admin/settings/business", BUSINESS);
    await publishHome(owner, [intro, ...rest]);
    const page = await html(made, "/");
    const main = page.slice(page.indexOf("<main"), page.indexOf("</main>"));
    const sections = 1 + rest.filter((block) => "attrs" in block).length;
    expect(main.match(/<section/g)).toHaveLength(sections);
    expect(main.match(/<\/section>/g)).toHaveLength(sections);
    expect(main.match(/class="t-business"/g) ?? []).toHaveLength(sections - 1);
    expect(main).not.toContain("tend-business");
  });

  test("opens with its title when there's no Big intro, or not first", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    await owner.put("/api/admin/settings/business", BUSINESS);
    for (const content of [[paragraph("Hello.")], [paragraph("Hello."), intro]]) {
      await publishHome(owner, content);
      const page = await html(made, "/");
      expect(page).toContain("<h1>Rise Bakery</h1>");
      expect(page).not.toContain("t-glance");
      expect(page).not.toContain("t-hidden");
    }
  });

  test("gives its photo the room it has: the whole width behind the words, or half beside them", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const id = await upload(owner);
    const picture = { type: "image", attrs: { mediaId: id } };
    for (const [preset, size, sizes] of [
      ["1", "half", "(min-width: 82rem) 41rem, (min-width: 46rem) 52vw, 100vw"],
      ["2", "full", "100vw"],
    ] as const) {
      await publishHome(owner, [
        section("intro", [picture, heading("Bread"), picture], preset),
        picture,
      ]);
      const page = await html(made, "/");
      const figures = [...page.matchAll(/<figure class="t-image t-size-([a-z]+)">/g)];
      // Only the first is the one it opens with: another is a picture like any other.
      expect(figures.map((match) => match[1])).toEqual([size, "normal", "normal"]);
      const first = page.slice(page.indexOf("<figure"), page.indexOf("</figure>"));
      expect(first).toContain(`sizes="${sizes}"`);
      expect(first).toContain('fetchpriority="high"');
    }
  });
});

describe("a post", () => {
  async function publishPost(owner: Client, fields: object) {
    const made = await (await owner.post("/api/admin/entries", { type: "post" })).json();
    const saved = await owner.patch(`/api/admin/entries/${made.id}`, fields, {
      "If-Match": String(made.rev),
    });
    const published = await owner.post(
      `/api/admin/entries/${made.id}/publish`,
      {},
      { "If-Match": String((await saved.json()).rev) },
    );
    expect(published.status).toBe(200);
    return (await published.json()).url as string;
  }

  test("opens with its picture, unless its own words show it", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const id = await upload(owner);
    const chosen = await publishPost(owner, {
      title: "Rye",
      featuredImage: { mediaId: id, alt: null },
      doc: { type: "doc", content: [paragraph("On Fridays.")] },
    });
    const shown = await html(made, chosen);
    expect(shown).toContain('class="t-img-cover"');
    const inside = await publishPost(owner, {
      title: "Buns",
      doc: { type: "doc", content: [{ type: "image", attrs: { mediaId: id } }] },
    });
    const once = await html(made, inside);
    expect(once).not.toContain("t-img-cover");
    expect(once.match(/<img /g)).toHaveLength(1);
    // And leads back to the others.
    expect(shown).toContain('href="/blog">More posts</a>');
  });
});

describe("its header and footer", () => {
  test("have the telephone number once there is one, and say every network's name", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    expect(await html(made, "/")).not.toContain("t-header-call");
    await owner.put("/api/admin/settings/business", { ...BUSINESS, email: null });
    const networks = [
      ["instagram", "Instagram"],
      ["facebook", "Facebook"],
      ["tiktok", "TikTok"],
      ["youtube", "YouTube"],
      ["x", "X"],
      ["linkedin", "LinkedIn"],
      ["pinterest", "Pinterest"],
      ["threads", "Threads"],
      ["bluesky", "Bluesky"],
      ["mastodon", "Mastodon"],
    ];
    await design(
      owner,
      {},
      {
        social: [
          ...networks.map(([network]) => ({ network, url: `https://${network}.example/rise` })),
          { network: "other", url: "https://ko-fi.com/rise" },
        ],
      },
    );
    const page = await html(made, "/");
    const call = page.match(/<a class="[^"]*t-header-call" href="([^"]+)">([\s\S]*?)<\/a>/);
    expect(call?.[1]).toBe("tel:+63285550100");
    expect(call?.[2]).toContain("<span>+63 2 8555 0100</span>");
    const list = page.match(/<ul class="t-social"[\s\S]*?<\/ul>/)?.[0] ?? "";
    for (const [network, name] of networks) {
      const link = list.match(
        new RegExp(`href="https://${network}\\.example[^>]*>([\\s\\S]*?)</a>`),
      );
      // Its sign for those who see it, and its name for those who don't.
      expect(link?.[1], network).toMatch(
        new RegExp(
          `^<svg [^>]*aria-hidden="true">.+</svg>\\s*<span class="t-hidden">${name}</span>$`,
          "s",
        ),
      );
    }
    // One Tend has no sign for has its name alone.
    expect(list).toMatch(/href="https:\/\/ko-fi\.com\/rise"[^>]*>ko-fi\.com<\/a>/);
  });
});

describe("its fonts", () => {
  const FONTS = join(defaultThemeDir, "assets", "fonts");

  test("are fetched from the site itself, each at an address that's kept for good", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    expect(await html(made, "/")).not.toContain("woff2");
    const used = new Set<string>();
    for (const [fonts, family] of [
      ["classic", "Fraunces"],
      ["friendly", "Nunito"],
    ] as const) {
      await design(owner, { fonts });
      const page = await html(made, "/");
      expect(page).toContain(`data-fonts="${fonts}"`);
      const addresses = [...page.matchAll(/url\("([^"]+)"\)/g)].map((match) => match[1] as string);
      expect(addresses.length).toBeGreaterThan(1);
      // One is fetched straight away, and it's one the page has, so it isn't fetched twice.
      const early = [...page.matchAll(/<link rel="preload" href="([^"]+)" as="font"[^>]*>/g)];
      expect(early).toHaveLength(1);
      expect(early[0]?.[0]).toContain("crossorigin");
      expect(addresses).toContain(early[0]?.[1]);
      for (const address of addresses) {
        expect(address).toMatch(/^\/assets\/meadow\/[0-9a-f]{12}\/fonts\/[a-z-]+\.woff2$/);
        used.add(address.split("/").at(-1) as string);
        const reply = await made.app.request(address);
        expect(reply.status, address).toBe(200);
        expect(reply.headers.get("content-type")).toBe("font/woff2");
        expect(reply.headers.get("cache-control")).toContain("immutable");
      }
      // A device's own font stands in until they're here, so the page never waits for them.
      expect(page.match(/font-display: swap/g)).toHaveLength(addresses.length);
      expect(page).toContain(`font-family: "${family} until it's here"`);
    }
    // Nothing Tend comes with is left over.
    expect([...used].sort()).toEqual(
      readdirSync(FONTS)
        .filter((name) => name.endsWith(".woff2"))
        .sort(),
    );
  });

  test("come with their licences, and stay small", () => {
    for (const name of ["Fraunces", "Nunito"]) {
      const licence = readFileSync(join(FONTS, `${name}-OFL.txt`), "utf8");
      expect(licence).toContain(`The ${name} Project Authors`);
      expect(licence).toContain("SIL OPEN FONT LICENSE Version 1.1");
    }
    // What nearly every page of a site in English, or another language of Western Europe, loads.
    for (const name of ["fraunces-latin", "nunito-latin"]) {
      expect(statSync(join(FONTS, `${name}.woff2`)).size).toBeLessThan(70_000);
    }
  });
});
