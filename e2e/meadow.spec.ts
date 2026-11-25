import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { createEntry, expect, photo, type Site, test, upload } from "./fixtures.ts";

// How Meadow looks, where looking right can be measured: words on photos, its fonts, and every
// kind of section in every style a site can have.

const text = (value: string, marks?: unknown[]) => ({
  type: "text",
  text: value,
  ...(marks ? { marks } : {}),
});
const paragraph = (...content: unknown[]) => ({ type: "paragraph", content });
const heading = (words: string) => ({
  type: "heading",
  attrs: { level: 2 },
  content: [text(words)],
});
const button = (label: string) => ({ type: "button", attrs: { href: "/contact", label } });
const picture = (mediaId: string, caption?: string) => ({
  type: "image",
  attrs: { mediaId, ...(caption ? { caption } : {}) },
});
const section = (
  kind: string,
  content: unknown[],
  { preset = "1", tone = "none", align = "left" } = {},
) => ({ type: "section", attrs: { kind, preset, tone, align }, content });

const TONES = ["none", "muted", "accent"];

async function publishPage(page: Page, site: Site, title: string, content: unknown[]) {
  const entry = await createEntry(page, site, { type: "page", title });
  const saved = await (
    await page.request.patch(`${site.base}/api/admin/entries/${entry.id}`, {
      headers: { "If-Match": String(entry.rev) },
      data: { doc: { type: "doc", content } },
    })
  ).json();
  const published = await page.request.post(`${site.base}/api/admin/entries/${entry.id}/publish`, {
    headers: { "If-Match": String(saved.rev) },
    data: {},
  });
  expect(published.status()).toBe(200);
  return (await published.json()).url as string;
}

async function setDesign(page: Page, site: Site, theme: Record<string, string>): Promise<void> {
  const design = await (await page.request.get(`${site.base}/api/admin/design`)).json();
  const saved = await page.request.put(`${site.base}/api/admin/design`, {
    data: { ...design.value, theme: { ...design.value.theme, ...theme } },
  });
  expect(saved.status()).toBe(200);
}

async function setBusinessDetails(page: Page, site: Site): Promise<void> {
  const reply = await page.request.put(`${site.base}/api/admin/settings/business`, {
    data: {
      address: "1 Main Street\nSpringfield",
      phone: "+1 555 010 0200",
      email: "hello@example.com",
      mapUrl: "https://maps.example.com/shop",
      hours: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((day) => ({
        day,
        closed: day === "sun",
        opens: "08:00",
        closes: "17:00",
      })),
      hoursNote: "Closed on public holidays",
    },
  });
  expect(reply.status()).toBe(200);
}

/** A photo that's one colour all over, which is the hardest to write on. */
async function plain(page: Page, color: string): Promise<Buffer> {
  if (page.url() === "about:blank") await page.goto("data:text/html,<title>x</title>");
  const base64 = await page.evaluate((fill) => {
    const canvas = document.createElement("canvas");
    canvas.width = 1600;
    canvas.height = 1000;
    const context = canvas.getContext("2d") as CanvasRenderingContext2D;
    context.fillStyle = fill;
    context.fillRect(0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png").split(",")[1] as string;
  }, color);
  return Buffer.from(base64, "base64");
}

interface Words {
  name: string;
  /** Where each line of them is on the page. */
  lines: { x: number; y: number; width: number; height: number }[];
}

/** Every line of words in a big intro that's on its photo rather than in a filled button. */
function wordsOnPhotos(page: Page): Promise<Words[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll(".t-intro")].flatMap((intro, index) =>
      [...intro.querySelectorAll("h2, p:not(.t-button-row), figcaption")].map((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        return {
          name: `${intro.className} ${index}: ${element.localName}`,
          lines: [...range.getClientRects()].map((box) => ({
            x: box.x + scrollX,
            y: box.y + scrollY,
            width: box.width,
            height: box.height,
          })),
        };
      }),
    ),
  );
}

/**
 * The least contrast between words and what's behind them, in a picture of the whole page
 * without its words. The words' colour comes from the browser, whichever way it gives it.
 */
async function leastContrast(page: Page, shot: Buffer, words: Words[]) {
  return page.evaluate(
    async ({ base64, words }) => {
      const bitmap = await createImageBitmap(
        new Blob([Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))]),
      );
      const canvas = Object.assign(document.createElement("canvas"), {
        width: bitmap.width,
        height: bitmap.height,
      });
      const context = canvas.getContext("2d") as CanvasRenderingContext2D;
      context.drawImage(bitmap, 0, 0);
      const all = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
      const luminance = (r: number, g: number, b: number) => {
        const [x, y, z] = [r, g, b].map((value) => {
          const c = value / 255;
          return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        }) as [number, number, number];
        return 0.2126 * x + 0.7152 * y + 0.0722 * z;
      };
      const swatch = document.createElement("canvas").getContext("2d", {
        willReadFrequently: true,
      }) as CanvasRenderingContext2D;
      const elements = [...document.querySelectorAll(".t-intro")].flatMap((intro) => [
        ...intro.querySelectorAll("h2, p:not(.t-button-row), figcaption"),
      ]);
      return words.map(({ name, lines }, index) => {
        swatch.fillStyle = getComputedStyle(elements[index] as Element).color;
        swatch.fillRect(0, 0, 1, 1);
        const [r, g, b] = swatch.getImageData(0, 0, 1, 1).data;
        const ink = luminance(r ?? 0, g ?? 0, b ?? 0);
        let least = 21;
        for (const line of lines) {
          for (let down = 0.1; down < 1; down += 0.2) {
            for (let across = 0; across <= 1; across += 0.05) {
              const x = Math.min(bitmap.width - 1, Math.round(line.x + line.width * across));
              const y = Math.min(bitmap.height - 1, Math.round(line.y + line.height * down));
              const at = (y * bitmap.width + x) * 4;
              const behind = luminance(all[at] ?? 0, all[at + 1] ?? 0, all[at + 2] ?? 0);
              const ratio = (Math.max(ink, behind) + 0.05) / (Math.min(ink, behind) + 0.05);
              least = Math.min(least, ratio);
            }
          }
        }
        return { name, least };
      });
    },
    { base64: shot.toString("base64"), words },
  );
}

test.describe("words on a photo", () => {
  for (const colorScheme of ["light", "dark"] as const) {
    test(`can be read on any photo, at any width, in ${colorScheme} mode`, async ({
      page,
      signedIn,
    }) => {
      test.setTimeout(120_000);
      await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
      // A yellow only just dark enough to read, and a bright blue: the hardest accents there are.
      await setDesign(page, signedIn, { accent: "#787100" });
      for (const shade of ["#ffffff", "#000000"]) {
        const { id } = await upload(page, signedIn, await plain(page, shade), `${shade}.png`);
        const url = await publishPage(
          page,
          signedIn,
          `On ${shade}`,
          TONES.flatMap((tone) =>
            ["left", "center"].map((align) =>
              section(
                "intro",
                [
                  picture(id, "The shelves, a little before seven in the morning"),
                  heading("Bread that takes its time, and is better for it every day"),
                  paragraph(
                    text("Sourdough, buns and pastries, proved for a day and baked all night. "),
                    text("Read more", [{ type: "link", attrs: { href: "https://example.com/" } }]),
                  ),
                  button("Find us"),
                ],
                { preset: "2", tone, align },
              ),
            ),
          ),
        );
        for (const width of [320, 414, 600, 735, 737, 900, 1024, 1280, 1600, 2200]) {
          await page.setViewportSize({ width, height: 900 });
          await page.goto(`${signedIn.base}${url}`);
          await page.evaluate(async () => {
            for (const image of document.images) image.loading = "eager";
            await Promise.all([...document.images].map((image) => image.decode()));
          });
          const words = await wordsOnPhotos(page);
          expect(words).toHaveLength(TONES.length * 2 * 3);
          // Their boxes stay, so what's behind them is where it was.
          await page.addStyleTag({
            content:
              ".t-intro :is(h2, p), .t-intro .t-button { visibility: hidden } .t-intro figcaption { color: transparent !important }",
          });
          const shot = await page.screenshot({ fullPage: true, scale: "css" });
          await page.addStyleTag({
            content: ".t-intro figcaption { color: inherit !important }",
          });
          for (const { name, least } of await leastContrast(page, shot, words)) {
            expect(least, `${shade}, ${width} px wide, ${name}`).toBeGreaterThanOrEqual(4.5);
          }
          const scrolls = await page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          );
          expect(scrolls, `${width} px: sideways scrolling`).toBeLessThanOrEqual(0);
        }
      }
    });
  }

  test("is the whole width of the window behind them, and half of it beside them", async ({
    page,
    signedIn,
  }) => {
    const { id } = await upload(page, signedIn, await photo(page, 1600, 1000), "loaves.jpg");
    const words = [heading("Bread"), paragraph(text("Every morning.")), button("Find us")];
    const url = await publishPage(page, signedIn, "Both ways", [
      section("intro", [picture(id), ...words], { preset: "1" }),
      section("intro", [...words, picture(id)], { preset: "2", tone: "accent" }),
    ]);
    const boxes = () =>
      page.evaluate(() =>
        [...document.querySelectorAll(".t-intro")].map((intro) => {
          const box = (element: Element | null) => {
            const { left, top, right, bottom } = (element as Element).getBoundingClientRect();
            return { left, top, right, bottom };
          };
          return {
            all: box(intro),
            photo: box(intro.querySelector("img")),
            words: box(intro.querySelector("h2")),
          };
        }),
      );
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${signedIn.base}${url}`);
    const [beside, behind] = await boxes();
    expect(beside?.words.right).toBeLessThanOrEqual(beside?.photo.left ?? 0);
    expect((beside?.photo.right ?? 0) - (beside?.photo.left ?? 0)).toBeGreaterThan(450);
    expect(behind?.photo).toEqual(behind?.all);
    // On a phone there's no room for both, so the photo comes first.
    await page.setViewportSize({ width: 390, height: 844 });
    const [above] = await boxes();
    expect(above?.photo.bottom).toBeLessThanOrEqual(above?.words.top ?? 0);
  });
});

test.describe("every kind of section", () => {
  for (const fonts of ["clean", "classic", "friendly"]) {
    for (const colorScheme of ["light", "dark"] as const) {
      test(`has no accessibility violations with ${fonts} fonts in ${colorScheme} mode`, async ({
        page,
        signedIn,
      }) => {
        test.setTimeout(60_000);
        await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
        await setBusinessDetails(page, signedIn);
        await setDesign(page, signedIn, { fonts, accent: "#8a4b1f" });
        const { id } = await upload(page, signedIn, await photo(page, 1600, 1000), "loaves.jpg");
        const quote = { type: "blockquote", content: [paragraph(text("The best in town."))] };
        const list = {
          type: "bulletList",
          content: [{ type: "listItem", content: [paragraph(text("Rye, on Fridays"))] }],
        };
        const link = text("Read more", [{ type: "link", attrs: { href: "https://example.com/" } }]);
        const url = await publishPage(page, signedIn, "Everything", [
          paragraph(text("Opening words.")),
          ...TONES.flatMap((tone, index) => {
            const style = { tone, align: index % 2 ? "center" : "left" };
            return [
              section(
                "intro",
                [heading("Bread"), paragraph(text("Daily. "), link), button("A"), button("B")],
                style,
              ),
              section(
                "intro",
                [picture(id), heading("Beside"), paragraph(link), button("A")],
                style,
              ),
              section(
                "pictureText",
                [
                  picture(id, "Our ovens"),
                  heading("Ovens"),
                  paragraph(link),
                  quote,
                  list,
                  button("A"),
                ],
                style,
              ),
              section("contact", [heading("Come by"), paragraph(link)], { ...style, preset: "2" }),
            ];
          }),
          paragraph(text("And on the page itself. "), link),
          quote,
          list,
          { type: "codeBlock", content: [text("flour + water")] },
          { type: "horizontalRule" },
          picture(id, "One more"),
          button("The end"),
        ]);
        for (const width of [1280, 320]) {
          await page.setViewportSize({ width, height: 900 });
          await page.goto(`${signedIn.base}${url}`);
          await page.waitForLoadState("networkidle");
          const { violations } = await new AxeBuilder({ page }).analyze();
          expect(
            violations.map(({ id: rule, nodes }) => `${rule}: ${nodes[0]?.target}`),
            `${width} px`,
          ).toEqual([]);
          const scrolls = await page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          );
          expect(scrolls, `${width} px: sideways scrolling`).toBeLessThanOrEqual(0);
        }
      });
    }
  }
});

test.describe("its fonts", () => {
  test("come from the site itself, once each, and only the ones a page has letters for", async ({
    page,
    signedIn,
  }) => {
    await createEntry(page, signedIn, { title: "Fresh loaves", body: "Every day.", publish: true });
    const fetched: string[] = [];
    page.on("request", (request) => {
      if (request.resourceType() === "font") fetched.push(request.url());
    });
    for (const [fonts, family, file] of [
      ["clean", null, null],
      ["classic", "Fraunces", "fraunces-latin.woff2"],
      ["friendly", "Nunito", "nunito-latin.woff2"],
    ] as const) {
      await setDesign(page, signedIn, { fonts });
      fetched.length = 0;
      await page.goto(`${signedIn.base}/blog/fresh-loaves`);
      await page.evaluate(() => document.fonts.ready);
      await page.waitForLoadState("networkidle");
      expect(
        fetched.map((url) => url.split("/").at(-1)),
        fonts,
      ).toEqual(file ? [file] : []);
      for (const url of fetched) expect(url.startsWith(`${signedIn.base}/`), url).toBe(true);
      const heading = page.getByRole("heading", { level: 1 });
      const used = await heading.evaluate((element) => getComputedStyle(element).fontFamily);
      if (family) {
        expect(used).toContain(family);
        // It's the real font, not the one standing in for it.
        expect(await page.evaluate((name) => document.fonts.check(`20px ${name}`), family)).toBe(
          true,
        );
      }
    }
  });

  test("hardly move anything when they arrive late", async ({
    page,
    signedIn,
    browserName,
    playwright,
  }) => {
    test.skip(browserName !== "chromium", "only Chromium measures this");
    test.setTimeout(90_000);
    // On Linux, Chromium without a window rounds each letter to whole pixels, which few people's
    // devices do, so a font and the one standing in for it would never quite fit there.
    const browser = await playwright.chromium.launch({ args: ["--font-render-hinting=none"] });
    const visitor = await browser.newPage();
    const { id } = await upload(page, signedIn, await photo(page, 1600, 1000), "loaves.jpg");
    const home = await publishPage(page, signedIn, "Fresh bread, every day of the week", [
      section("intro", [picture(id), heading("Bread that takes its time"), button("Find us")], {
        preset: "2",
        tone: "accent",
      }),
      section("pictureText", [
        picture(id),
        heading("Made by hand, before you're up"),
        paragraph(text("We shape every bun and loaf ourselves, starting at two in the morning.")),
      ]),
    ]);
    const story = await publishPage(page, signedIn, "Our story so far, and what comes after it", [
      paragraph(
        text(
          "Our bakery opened in the spring of 1998 with one oven, three tables and a borrowed mixer. Today there are eleven of us, and the starter is older than the youngest.",
        ),
      ),
      heading("How it began, one wet Tuesday in March"),
      paragraph(
        text(
          "Nous cuisons chaque matin, sauf le lundi, et tout est fait à la main. Réservez votre table pour le dîner du samedi soir.",
        ),
      ),
      heading("What our neighbours say about the cinnamon knots"),
      paragraph(
        text(
          "Come early on Saturdays: the knots are gone by nine, and the rye by ten. We take cards, cash and the occasional jar of good jam.",
        ),
      ),
    ]);
    await visitor.addInitScript(() => {
      const found = window as unknown as { moved: number };
      found.moved = 0;
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as unknown as { value: number }[]) {
          found.moved += entry.value;
        }
      }).observe({ type: "layout-shift", buffered: true });
    });
    await visitor.route("**/*.woff2", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 700));
      await route.continue();
    });
    for (const [fonts, family] of [
      ["classic", "Fraunces"],
      ["friendly", "Nunito"],
    ] as const) {
      await setDesign(page, signedIn, { fonts });
      await visitor.goto(`${signedIn.base}${home}`);
      // What takes its place: regular, and bold. Linux has nothing like Georgia, for Classic.
      const standIns = await visitor.evaluate(async (name) => {
        const faces = await Promise.all(
          [400, 800].map((weight) =>
            document.fonts.load(`${weight} 20px "${name}"`).catch(() => []),
          ),
        );
        return faces.every((found) => found.length > 0);
      }, `${family} until it's here`);
      if (fonts === "classic" && !standIns && process.platform === "linux") continue;
      expect(standIns, `${fonts}: this device has a font to stand in`).toBe(true);
      for (const url of [home, story]) {
        for (const size of [
          { width: 360, height: 780 },
          { width: 412, height: 844 },
          { width: 768, height: 1024 },
          { width: 1280, height: 800 },
        ]) {
          await visitor.setViewportSize(size);
          await visitor.goto(`${signedIn.base}${url}`);
          await visitor.waitForLoadState("networkidle");
          await visitor.evaluate(() => document.fonts.ready);
          await visitor.waitForTimeout(200);
          const { moved, arrived } = await visitor.evaluate(
            (name) => ({
              moved: (window as unknown as { moved: number }).moved,
              arrived: document.fonts.check(`20px ${name}`),
            }),
            family,
          );
          expect(arrived, `${fonts} at ${size.width} px, ${url}`).toBe(true);
          // The plan's limit, for the whole page (PLAN.md §11).
          expect(moved, `${fonts} at ${size.width} px, ${url}`).toBeLessThanOrEqual(0.05);
        }
      }
    }
    await browser.close();
  });
});
