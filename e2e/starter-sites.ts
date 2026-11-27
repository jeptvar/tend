import type { Page } from "@playwright/test";
import { expect, OWNER, type Site, upload } from "./fixtures.ts";

// Sites made from each starting point, as they come or filled in the way an owner soon
// would, for the checks that measure what visitors get: e2e/budgets.spec.ts on every pull
// request, and e2e/lighthouse.spec.ts nightly.

export const STARTERS = ["blog", "business", "portfolio", "blank"] as const;
export type Starter = (typeof STARTERS)[number];

interface Summary {
  id: string;
  slug: string;
  isHome: boolean;
  rev: number;
  url: string | null;
}

type Block = Record<string, unknown>;

const text = (value: string) => ({ type: "text", text: value });
const paragraph = (value: string) => ({ type: "paragraph", content: [text(value)] });
const heading = (value: string) => ({
  type: "heading",
  attrs: { level: 2 },
  content: [text(value)],
});

/**
 * A picture that weighs about what a detailed photo does: light and colour that change
 * slowly, with ever finer and fainter shapes and grain on top. It's drawn from a fixed seed,
 * so every run uploads the same picture. A flat test card shrinks to almost nothing, and
 * every size limit would pass whatever Tend sends.
 */
export async function photoLike(page: Page, seed: number, width = 2400, height = 1600) {
  if (page.url() === "about:blank") await page.goto("data:text/html,<title>x</title>");
  const base64 = await page.evaluate(
    async ({ seed, width, height }) => {
      // mulberry32: a small generator that gives the same numbers for the same seed.
      let state = seed;
      const random = () => {
        state = (state + 0x6d2b79f5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
      };
      const smooth = (t: number) => t * t * (3 - 2 * t);
      // Random values on a grid, blended smoothly in between, scaled by how much they change.
      const layer = (cell: number, amount: number) => {
        const columns = Math.ceil(width / cell) + 2;
        const grid = Float32Array.from({ length: columns * (Math.ceil(height / cell) + 2) }, () =>
          random(),
        );
        return (x: number, y: number) => {
          const left = Math.floor(x / cell);
          const top = Math.floor(y / cell);
          const across = smooth(x / cell - left);
          const down = smooth(y / cell - top);
          const at = top * columns + left;
          const a = grid[at] ?? 0;
          const b = grid[at + 1] ?? 0;
          const c = grid[at + columns] ?? 0;
          const d = grid[at + columns + 1] ?? 0;
          const upper = a + (b - a) * across;
          return (upper + (c + (d - c) * across - upper) * down) * amount;
        };
      };
      const [red, green, blue] = [layer(600, 40), layer(600, 40), layer(600, 40)];
      const light = [layer(300, 50), layer(80, 30), layer(20, 24), layer(6, 20), layer(2, 10)];
      const pixels = new ImageData(width, height);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          let value = 128 + random() * 8;
          for (const change of light) value += change(x, y);
          const at = (y * width + x) * 4;
          pixels.data[at] = value + red(x, y);
          pixels.data[at + 1] = value + green(x, y);
          pixels.data[at + 2] = value + blue(x, y);
          pixels.data[at + 3] = 255;
        }
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      (canvas.getContext("2d") as CanvasRenderingContext2D).putImageData(pixels, 0, 0);
      const blob = await new Promise<Blob>((resolve) =>
        canvas.toBlob((made) => resolve(made as Blob), "image/jpeg", 0.92),
      );
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary);
    },
    { seed, width, height },
  );
  return Buffer.from(base64, "base64");
}

async function picture(page: Page, site: Site, seed: number, alt: string): Promise<string> {
  const uploaded = await upload(page, site, await photoLike(page, seed), `photo-${seed}.jpg`);
  const described = await page.request.patch(`${site.base}/api/admin/media/${uploaded.id}`, {
    data: { alt },
  });
  expect(described.ok()).toBe(true);
  return uploaded.id;
}

async function find(page: Page, site: Site, type: "post" | "page", slug: string) {
  const reply = await page.request.get(`${site.base}/api/admin/entries?type=${type}`);
  const { entries } = (await reply.json()) as { entries: Summary[] };
  const found = entries.find((entry) => entry.slug === slug);
  if (!found) throw new Error(`The ${type} "${slug}" isn't there.`);
  return found;
}

/** Saves new contents over what the starting point gave, and publishes them. */
async function publish(
  page: Page,
  site: Site,
  entry: Summary,
  change: (doc: { content: Block[] }) => Record<string, unknown>,
): Promise<Summary> {
  const address = `${site.base}/api/admin/entries/${entry.id}`;
  const current = await (await page.request.get(address)).json();
  const saved = await page.request.patch(address, {
    headers: { "If-Match": String(current.rev) },
    data: change(current.data.doc),
  });
  expect(saved.ok(), await saved.text()).toBe(true);
  const published = await page.request.post(`${address}/publish`, {
    headers: { "If-Match": String((await saved.json()).rev) },
    data: {},
  });
  expect(published.ok(), await published.text()).toBe(true);
  return published.json();
}

/**
 * Sets up a site from a starting point, either as it comes or filled in: a Big intro with
 * a photo on the Business homepage, and photos on the Blog's first post. Blank stays as it
 * comes. Returns the addresses to measure: the homepage, and for the Blog its first post.
 */
export async function buildStarterSite(
  page: Page,
  site: Site,
  starter: Starter,
  state: "as it comes" | "filled in",
) {
  const setup = await page.request.post(`${site.base}/api/auth/setup`, {
    data: {
      code: site.code,
      site: { name: "Rise Bakery", tagline: "Fresh bread", locale: "en", timezone: "UTC" },
      owner: OWNER,
      starter,
    },
  });
  expect(setup.status()).toBe(201);
  const home = `${site.base}/`;
  if (starter === "blank") return [home];
  const work = async () => `${site.base}${(await find(page, site, "page", "work")).url}`;
  if (state === "as it comes") {
    if (starter === "business") return [home];
    if (starter === "portfolio") return [home, await work()];
    return [home, `${site.base}${(await find(page, site, "post", "welcome")).url}`];
  }

  const loaves = await picture(page, site, 1, "Loaves cooling on a rack by the window");
  const counter = await picture(page, site, 2, "The counter in the morning, full of pastries");
  if (starter === "business") {
    await publish(page, site, await find(page, site, "page", "home"), (doc) => ({
      doc: {
        type: "doc",
        content: [
          {
            type: "section",
            attrs: { kind: "intro", preset: "1", tone: "none", align: "left" },
            content: [
              heading("Bread worth getting up for"),
              paragraph(
                "Sourdough, rye and seeded loaves, baked before dawn in a wood-fired oven.",
              ),
              { type: "image", attrs: { mediaId: loaves, size: "full" } },
              { type: "button", attrs: { href: "/contact", label: "Find us" } },
            ],
          },
          ...doc.content,
          {
            type: "section",
            attrs: { kind: "pictureText", preset: "1", tone: "muted", align: "left" },
            content: [
              { type: "image", attrs: { mediaId: counter } },
              heading("Coffee and pastries"),
              paragraph("Croissants, buns and good coffee from seven, every day but Sunday."),
            ],
          },
        ],
      },
    }));
    return [home];
  }
  if (starter === "portfolio") {
    await publish(page, site, await find(page, site, "page", "work"), (doc) => ({
      doc: {
        type: "doc",
        content: [
          { type: "image", attrs: { mediaId: loaves, size: "wide", caption: "Loaves, on a rack" } },
          { type: "image", attrs: { mediaId: counter, caption: "The counter, in the morning" } },
          ...doc.content,
        ],
      },
    }));
    return [home, await work()];
  }

  const post = await publish(page, site, await find(page, site, "post", "welcome"), () => ({
    featuredImage: { mediaId: loaves },
    doc: {
      type: "doc",
      content: [
        paragraph(
          "We bake every loaf by hand, from flour milled a few miles away, and we start before " +
            "five so the first ones are cool enough to slice when the doors open at seven.",
        ),
        { type: "image", attrs: { mediaId: counter, caption: "The counter just after opening" } },
        heading("What we bake"),
        paragraph(
          "Sourdough takes two days: a night for the starter, a day for the dough to rise " +
            "slowly in the cold. Rye is darker and denser, with caraway if you ask for it. The " +
            "seeded loaf has sunflower, pumpkin, flax and sesame, toasted the evening before.",
        ),
        {
          type: "bulletList",
          content: ["Sourdough", "Light rye", "Seeded wholemeal", "Baguettes, from ten"].map(
            (item) => ({ type: "listItem", content: [paragraph(item)] }),
          ),
        },
        heading("Ordering ahead"),
        paragraph(
          "For a large order, or a cake for a birthday, tell us two days before. Call, or " +
            "come in and ask at the counter. We'll write it in the book and have it ready.",
        ),
      ],
    },
  }));
  return [home, `${site.base}${post.url}`];
}
