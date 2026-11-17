import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, test, vi } from "vitest";
import type { Media } from "../src/media/library.ts";
import { defaultThemeDir } from "../src/paths.ts";
import { contrast, readableOn } from "../src/site/color.ts";
import { imagePlaceholder, resolveMediaPlaceholders } from "../src/site/placeholders.ts";
import { darkAccent } from "../src/site/router.ts";
import { type MadeApp, makeApp, setUp } from "./auth-helpers.ts";
import { tempDir } from "./helpers.ts";

// Every icon made, with what it was made from, so a test can see how many were made and how
// big a picture each one had to open. Icons are still made for real.
const iconSources = vi.hoisted(() => [] as unknown[]);
vi.mock("../src/media/process.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/media/process.ts")>();
  return {
    ...actual,
    makeIcon: (...args: Parameters<typeof actual.makeIcon>) => {
      iconSources.push(args[0]);
      return actual.makeIcon(...args);
    },
  };
});

type Client = Awaited<ReturnType<typeof setUp>>;

async function opaque(width: number, height: number, background = "#884422"): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background } })
    .png()
    .toBuffer();
}

/** The usual kind of logo: a dark name on a see-through background. */
async function wordmark(): Promise<Buffer> {
  const name = await sharp({
    create: { width: 400, height: 60, channels: 4, background: "#1d2420" },
  })
    .png()
    .toBuffer();
  return sharp({
    create: { width: 600, height: 150, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: name, left: 100, top: 45 }])
    .png()
    .toBuffer();
}

async function upload(owner: Client, data: Buffer, name = "Picture.png") {
  const reply = await owner.upload("/api/admin/media", data, name);
  expect(reply.status).toBe(201);
  return reply.json();
}

async function design(owner: Client, changes: Record<string, unknown>) {
  const current = await (await owner.get("/api/admin/design")).json();
  const saved = await owner.put("/api/admin/design", { ...current.value, ...changes });
  expect(saved.status).toBe(200);
  return (await saved.json()).value;
}

async function page(made: MadeApp, path: string) {
  const reply = await made.app.request(path);
  return { status: reply.status, headers: reply.headers, html: await reply.text() };
}

function iconLink(html: string): string {
  const href = html.match(/<link rel="icon" href="([^"]+)"/)?.[1];
  expect(href).toBeTruthy();
  return href as string;
}

/** Where a picture's icon of this size would be, at the picture's current version. */
function iconOf(item: { id: string; thumbUrl: string }, size = 32): string {
  const hash = item.thumbUrl.split("/")[3];
  return `/media/${item.id}/${hash}/icon-${size}.png`;
}

function iconFilesOf(made: MadeApp, id: string): string[] {
  const dir = join(made.uploadsDir, "variants", id);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true })
    .map(String)
    .filter((name) => /icon-/.test(name));
}

async function expectPlainNotFound(made: MadeApp, path: string) {
  const reply = await made.app.request(path);
  expect(reply.status, path).toBe(404);
  expect(reply.headers.get("content-type"), path).toContain("text/plain");
}

describe("site-1: icons are only made for the site's icon", () => {
  test("any other picture's icon is a plain 404, and nothing is made for it", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const logo = await upload(owner, await opaque(600, 200), "Logo.png");
    const photo = await upload(owner, await opaque(2000, 1200), "Photo.png");
    await design(owner, { logoId: logo.id });

    iconSources.length = 0;
    for (const size of [32, 180, 512]) await expectPlainNotFound(made, iconOf(photo, size));
    // The ID alone isn't enough either: a made-up version isn't led to the current one.
    await expectPlainNotFound(made, `/media/${photo.id}/000000000000/icon-32.png`);
    expect(iconSources).toHaveLength(0);
    expect(iconFilesOf(made, photo.id)).toEqual([]);

    const served = await made.app.request(iconLink((await page(made, "/")).html));
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
  });

  test("the icon follows Design: the icon chosen there, else the logo, as it is right now", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const first = await upload(owner, await opaque(600, 200), "First.png");
    const second = await upload(owner, await opaque(600, 200, "#224488"), "Second.png");
    const icon = await upload(owner, await opaque(300, 300, "#228844"), "Icon.png");

    await design(owner, { logoId: first.id });
    const before = iconLink((await page(made, "/")).html);
    expect((await made.app.request(before)).status).toBe(200);

    // A new logo: its icon works straight away, and the old one's is gone, even though
    // its file was already made.
    await design(owner, { logoId: second.id });
    const after = iconLink((await page(made, "/")).html);
    expect(after).toContain(second.id);
    expect((await made.app.request(after)).status).toBe(200);
    await expectPlainNotFound(made, before);

    // An icon of its own wins over the logo.
    await design(owner, { iconId: icon.id });
    const own = iconLink((await page(made, "/")).html);
    expect(own).toContain(icon.id);
    expect((await made.app.request(own)).status).toBe(200);
    await expectPlainNotFound(made, after);

    // An old version of the icon's own picture still leads to the current one.
    const old = own.replace(/\/media\/([^/]+)\/[^/]+\//, "/media/$1/000000000000/");
    const moved = await made.app.request(old);
    expect(moved.status).toBe(302);
    expect(moved.headers.get("location")).toBe(own);
  });

  test("a burst of requests for one icon makes it once, and every one gets it", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const logo = await upload(owner, await opaque(2000, 1200), "Logo.png");
    await design(owner, { logoId: logo.id });
    const touch = (await page(made, "/")).html.match(/<link rel="apple-touch-icon" href="([^"]+)"/);
    const url = touch?.[1] as string;

    iconSources.length = 0;
    const replies = await Promise.all(Array.from({ length: 20 }, () => made.app.request(url)));
    expect(replies.map((reply) => reply.status)).toEqual(Array(20).fill(200));
    const bodies = await Promise.all(
      replies.map(async (reply) => Buffer.from(await reply.arrayBuffer())),
    );
    expect(bodies.every((body) => body.equals(bodies[0] as Buffer))).toBe(true);
    expect(iconSources).toHaveLength(1);

    // Made once, it's kept: later requests open nothing.
    expect((await made.app.request(url)).status).toBe(200);
    expect(iconSources).toHaveLength(1);
  });

  test("an icon is made from a stored size just big enough, never the full original", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const logo = await upload(owner, await opaque(2000, 1200), "Logo.png");
    await design(owner, { logoId: logo.id });

    for (const [size, width] of [
      [32, 480],
      [512, 960],
    ] as const) {
      iconSources.length = 0;
      const served = await made.app.request(iconOf(logo, size));
      expect(served.status, `icon-${size}`).toBe(200);
      const icon = await sharp(Buffer.from(await served.arrayBuffer())).metadata();
      expect([icon.width, icon.height], `icon-${size}`).toEqual([size, size]);
      const source = await sharp(iconSources[0] as Buffer).metadata();
      expect([source.format, source.width], `icon-${size}`).toEqual(["webp", width]);
    }
  });
});

const ID = "0193a0a0-0000-7000-8000-000000000001";

/** A picture as Media keeps it, without uploading one. */
function stored(overrides: Partial<Media> = {}): Media {
  return {
    id: ID,
    kind: "image",
    originalName: "Picture.png",
    mime: "image/png",
    ext: "png",
    sizeBytes: 1000,
    width: 600,
    height: 150,
    sha256: "a".repeat(64),
    variants: [480, 600],
    alt: null,
    decorative: 0,
    caption: null,
    credit: null,
    focalX: 0.5,
    focalY: 0.5,
    dominantColor: "#884422",
    uploadedBy: null,
    createdAt: 0,
    updatedAt: 0,
    trashedAt: null,
    ...overrides,
  } as Media;
}

function shown(placeholder: string, item: Media): string {
  return resolveMediaPlaceholders(placeholder, new Map([[item.id, item]]));
}

describe("site-2: see-through pictures show what's behind them", () => {
  test("the logo never gets a colour behind it, and a picture without one gets none", () => {
    const logo = shown(
      imagePlaceholder({ id: ID, size: "logo", alt: "Rise Bakery" }),
      stored({ dominantColor: "#080808" }),
    );
    expect(logo).toMatch(/^<img class="t-img-logo"/);
    expect(logo).not.toContain("background");
    expect(logo).not.toContain("style=");

    const clear = shown(
      imagePlaceholder({ id: ID, size: "normal" }),
      stored({ dominantColor: null }),
    );
    expect(clear).toContain("<img");
    expect(clear).not.toContain("style=");

    // A picture with a colour of its own still shows it while it loads.
    const photo = shown(imagePlaceholder({ id: ID, size: "normal" }), stored());
    expect(photo).toContain('style="background-color:#884422"');
  });

  test("a see-through logo in the header has nothing behind it", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const logo = await upload(owner, await wordmark(), "Logo.png");
    await design(owner, { logoId: logo.id });
    for (const path of ["/", "/contact"]) {
      const { html } = await page(made, path);
      const img = html.match(/<img class="t-img-logo"[^>]*>/)?.[0];
      expect(img, path).toBeTruthy();
      expect(img, path).not.toContain("style=");
    }
  });

  test("an opaque logo gets no colour behind it either", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const logo = await upload(owner, await opaque(600, 200), "Logo.png");
    await design(owner, { logoId: logo.id });
    const img = (await page(made, "/")).html.match(/<img class="t-img-logo"[^>]*>/)?.[0];
    expect(img).toBeTruthy();
    expect(img).not.toContain("style=");
  });
});

describe("site-3: words the theme gives a picture win over Media's decorative mark", () => {
  test("a logo marked decorative in Media still names the home link", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    const logo = await upload(owner, await opaque(600, 200), "Logo.png");
    await design(owner, { logoId: logo.id });
    const marked = await owner.patch(`/api/admin/media/${logo.id}`, { decorative: true });
    expect(marked.status).toBe(200);
    const { html } = await page(made, "/");
    const brand = html.match(/<a class="t-brand"[^>]*>([\s\S]*?)<\/a>/)?.[1] ?? "";
    expect(brand).toMatch(/^<img class="t-img-logo"[^>]+alt="Rise Bakery"/);
  });

  test("Media's decorative mark counts only when nothing else describes the picture", () => {
    const decorative = stored({ decorative: 1, alt: "From Media" });
    const given = shown(imagePlaceholder({ id: ID, size: "logo", alt: "Rise Bakery" }), decorative);
    expect(given).toContain('alt="Rise Bakery"');
    const nothingGiven = shown(imagePlaceholder({ id: ID, size: "normal" }), decorative);
    expect(nothingGiven).toContain('alt=""');
    // Decorative where it's placed is decorative, whatever words it has.
    const placedDecorative = shown(
      imagePlaceholder({ id: ID, size: "card", alt: "Words", decorative: true }),
      stored({ alt: "From Media" }),
    );
    expect(placedDecorative).toContain('alt=""');
    // Without any mark, Media's words are used when nothing else is given.
    expect(
      shown(imagePlaceholder({ id: ID, size: "normal" }), stored({ alt: "From Media" })),
    ).toContain('alt="From Media"');
  });
});

/** Two colours mixed the way the browser does, from 0 (all of b) to 1 (all of a). */
function mix(a: string, b: string, share: number): string {
  const channels = (hex: string) =>
    [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
  const [first, second] = [channels(a), channels(b)];
  return `#${first
    .map((value, index) =>
      Math.round(value * share + (second[index] as number) * (1 - share))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/**
 * The dark backgrounds links sit on, read from Meadow's own stylesheet: the page, and every
 * tone that lays a little of the text colour over it.
 */
function darkBackgrounds(): string[] {
  const css = readFileSync(join(defaultThemeDir, "assets", "theme.css"), "utf8");
  const dark = css.match(/prefers-color-scheme: dark\)\s*\{\s*:root\s*\{([^}]*)\}/)?.[1] ?? "";
  const paper = dark.match(/--tend-paper:\s*(#[0-9a-f]{6})/i)?.[1] as string;
  const ink = dark.match(/--tend-ink:\s*(#[0-9a-f]{6})/i)?.[1] as string;
  expect([paper, ink]).toEqual([expect.any(String), expect.any(String)]);
  const tones = [
    ...css.matchAll(
      /\.t-tone-[a-z-]+\s*\{\s*background:\s*color-mix\(in srgb, var\(--tend-ink\) (\d+)%, transparent\)/g,
    ),
  ].map((match) => mix(ink, paper, Number(match[1]) / 100));
  return [paper, ...tones];
}

describe("site-4: a changed accent in dark mode", () => {
  test("is readable on the page and in every tinted section, whatever the colour", () => {
    const backgrounds = darkBackgrounds();
    // The page and Muted, at least.
    expect(backgrounds.length).toBeGreaterThanOrEqual(2);
    const levels = Array.from({ length: 18 }, (_, index) => index * 15);
    const failing: string[] = [];
    for (const r of levels) {
      for (const g of levels) {
        for (const b of levels) {
          const accent = `#${[r, g, b].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
          const dark = darkAccent(accent);
          for (const behind of backgrounds) {
            const ratio = contrast(dark, behind);
            if (ratio < 4.5) failing.push(`${accent} → ${dark}: ${ratio.toFixed(2)} on ${behind}`);
          }
        }
      }
    }
    expect(failing.length, failing.slice(0, 5).join("; ")).toBe(0);
  });

  test("an accent readable already is left as it was", () => {
    for (const accent of ["#f59e0b", "#38bdf8", "#ffffff"]) expect(darkAccent(accent)).toBe(accent);
  });

  test("readableOn takes several backgrounds, and one on its own as before", () => {
    const both = readableOn("#1d4ed8", ["#141a17", "#212724"]);
    expect(contrast(both, "#141a17")).toBeGreaterThanOrEqual(4.5);
    expect(contrast(both, "#212724")).toBeGreaterThanOrEqual(4.5);
    expect(readableOn("#1d4ed8", "#141a17")).toBe("#6183e4");
    expect(readableOn("#1f6f4a", ["#ffffff"])).toBe("#1f6f4a");
  });

  test("links in the Contact page's Muted section are readable in dark mode", async () => {
    const made = await makeApp();
    const owner = await setUp(made, { starter: "business" });
    const current = await (await owner.get("/api/admin/design")).json();
    await design(owner, { theme: { ...current.value.theme, accent: "#1d4ed8" } });
    const { html } = await page(made, "/contact");
    expect(html).toContain("t-tone-muted");
    const dark = html.match(
      /prefers-color-scheme: dark\)\s*\{\s*:root\s*\{\s*--tend-accent:\s*(#[0-9a-f]{6})/,
    )?.[1] as string;
    expect(dark).toBeTruthy();
    for (const behind of darkBackgrounds()) {
      expect(contrast(dark, behind), behind).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("site-5: links to other sites", () => {
  test("are each named after their site, without www., not all just Link", async () => {
    const made = await makeApp();
    const owner = await setUp(made);
    await design(owner, {
      social: [
        { network: "instagram", url: "instagram.com/rise" },
        { network: "other", url: "https://ko-fi.com/rise" },
        { network: "other", url: "https://www.yelp.com/biz/rise" },
        { network: "other", url: "https://WWW.Bäckerei.example/rise" },
      ],
    });
    const { html } = await page(made, "/");
    const list = html.match(/<ul class="t-social"[\s\S]*?<\/ul>/)?.[0] ?? "";
    expect(list).toMatch(/href="https:\/\/instagram\.com\/rise"[^>]*>Instagram</);
    expect(list).toMatch(/href="https:\/\/ko-fi\.com\/rise"[^>]*>ko-fi\.com</);
    expect(list).toMatch(/href="https:\/\/www\.yelp\.com\/biz\/rise"[^>]*>yelp\.com</);
    expect(list).toMatch(/>bäckerei\.example</);
    expect(list).not.toContain(">Link<");
  });
});

/**
 * A copy of Meadow whose pages show their HTML as it is, as a theme without page-text.liquid
 * does. The business details then go in where the site itself finds their placeholder
 * (router.ts), not in Liquid as they do in Meadow.
 */
function themeShowingPagesAsTheyAre(): string {
  const dir = tempDir();
  cpSync(defaultThemeDir, dir, { recursive: true });
  const template = join(dir, "templates", "page.liquid");
  const meadow = readFileSync(template, "utf8");
  const asTheyAre = meadow.replace(/\{%\s*render "page-text"[^%]*%\}/, "{{ page.html | raw }}");
  expect(asTheyAre, "Meadow's page.liquid no longer renders page-text").not.toBe(meadow);
  writeFileSync(template, asTheyAre);
  return dir;
}

/** The Contact page, once business details with every kind of $ in them are saved. */
async function contactWithDollars(made: MadeApp): Promise<string> {
  const owner = await setUp(made, { starter: "business" });
  const saved = await owner.put("/api/admin/settings/business", {
    address: "1 Main St $'\nTown $`",
    phone: null,
    email: "a$$b@rise.example",
    mapUrl: null,
    hours: null,
    hoursNote:
      "Price range: $$ · Kids under 5 eat free ($'s off!) · see `$`menu · $& done · $5 lunch",
  });
  expect(saved.status).toBe(200);
  return (await page(made, "/contact")).html;
}

function expectAsTyped(html: string) {
  expect(html.match(/<!doctype html>/gi)).toHaveLength(1);
  expect(html).not.toContain("tend-business");
  expect(html).toContain(
    "Price range: $$ · Kids under 5 eat free ($&#39;s off!) · see `$`menu · $&amp; done · $5 lunch",
  );
  expect(html).toContain("1 Main St $&#39;<br>Town $`");
  expect(html).toContain(">a$$b@rise.example</a>");
}

describe("site-6: business details with $ in them", () => {
  test("come through as typed, and never copy the page into itself", async () => {
    // Meadow fills them in itself, with Liquid.
    expectAsTyped(await contactWithDollars(await makeApp()));
  });

  test("come through as typed when the site fills them in for the theme", async () => {
    const made = await makeApp({ themeDir: themeShowingPagesAsTheyAre() });
    const html = await contactWithDollars(made);
    expect(html).toContain('<div class="t-business">');
    expectAsTyped(html);
  });
});
