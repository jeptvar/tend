import { brotliCompressSync, constants } from "node:zlib";
import type { Browser } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { buildStarterSite, STARTERS } from "./starter-sites.ts";

// The budgets in PLAN.md §11 for what visitors download that can be counted exactly, so
// they're checked on every pull request. They're counted on a phone-sized screen (the
// "budgets" project in playwright.config.ts): a page offers each picture in several sizes,
// and the browser picks one by the width of the screen. Lighthouse times pages, which takes
// longer and varies more, so the plan runs it nightly instead.

const kB = 1000;
/** The page itself, as Tend sends it with brotli. */
const PAGE = 50 * kB;
/** A homepage and everything it loads before anyone scrolls: CSS, pictures and the page. */
const HOMEPAGE = 500 * kB;
/** The biggest thing on screen, when it's a picture. Until it's in, the page looks unready. */
const LARGEST_PICTURE = 150 * kB;
/** Default-theme pages run no code (P6). A script may only hold data, for search engines. */
const DATA_SCRIPTS = new Set(["application/ld+json", "speculationrules"]);

interface Largest {
  url: string;
  element: Element | null;
}

/**
 * The page with brotli, as Tend's page cache keeps it to send (packages/tendcms/src/site/
 * cache.ts). On a local address Tend caches and compresses nothing, so it's done here.
 */
function withBrotli(html: Buffer): number {
  return brotliCompressSync(html, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } }).length;
}

/** Opens a page as a new visitor would, signed out and with nothing cached, and counts. */
async function visit(browser: Browser, url: string) {
  const context = await browser.newContext();
  try {
    const html = await (await context.request.get(url)).body();
    const page = await context.newPage();
    const response = await page.goto(url, { waitUntil: "networkidle" });
    expect(response?.status()).toBe(200);
    const found = await page.evaluate(async () => {
      const largest = await new Promise<Largest | undefined>((resolve) => {
        new PerformanceObserver((list) =>
          resolve(list.getEntries().at(-1) as Largest | undefined),
        ).observe({ type: "largest-contentful-paint", buffered: true });
        setTimeout(() => resolve(undefined), 5_000);
      });
      const [navigation] = performance.getEntriesByType(
        "navigation",
      ) as PerformanceNavigationTiming[];
      const loaded = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
      const element = largest?.element;
      return {
        total: loaded.reduce(
          (sum, entry) => sum + entry.transferSize,
          navigation?.transferSize ?? 0,
        ),
        loaded: loaded.map((entry) => ({ url: entry.name, bytes: entry.transferSize })),
        scripts: Array.from(document.scripts, (script) => script.type),
        runsCode: Array.from(document.querySelectorAll("*")).flatMap((node) =>
          Array.from(node.attributes)
            .filter(({ name, value }) => name.startsWith("on") || /^\s*javascript:/i.test(value))
            .map(({ name }) => `<${node.localName} ${name}>`),
        ),
        unsized: Array.from(document.images)
          .filter(
            (image) => !["width", "height"].every((name) => Number(image.getAttribute(name)) > 0),
          )
          .map((image) => image.currentSrc || image.src),
        largest: largest?.url
          ? {
              picture: largest.url,
              bytes: loaded.find((entry) => entry.name === largest.url)?.transferSize ?? 0,
              fetchpriority: element?.getAttribute("fetchpriority") ?? null,
              loading: element?.getAttribute("loading") ?? null,
            }
          : { text: element?.textContent?.trim().slice(0, 80) ?? "" },
      };
    });
    return { ...found, page: withBrotli(html) };
  } finally {
    await context.close();
  }
}

/** Pictures fetched in more than one size, which a phone pays for twice. */
function fetchedTwice(loaded: { url: string }[]): string[] {
  const sizes = new Map<string, string[]>();
  for (const { url } of loaded) {
    const picture = new URL(url).pathname.match(/^\/media\/[^/]+\//)?.[0];
    if (picture) sizes.set(picture, [...(sizes.get(picture) ?? []), url]);
  }
  return [...sizes.values()].filter((urls) => urls.length > 1).flat();
}

for (const starter of STARTERS) {
  test(`${starter}: its pages stay within the budgets for what visitors download`, async ({
    page,
    site,
    browser,
  }) => {
    const [home, ...others] = await buildStarterSite(page, site, starter, "filled in");
    for (const url of [home as string, ...others]) {
      const where = `${starter} ${new URL(url).pathname}`;
      const measured = await visit(browser, url);
      await test.info().attach(where, {
        body: JSON.stringify(measured, null, 2),
        contentType: "application/json",
      });
      expect.soft(measured.page, `${where}: the page, with brotli`).toBeLessThanOrEqual(PAGE);
      expect
        .soft(
          measured.scripts.filter((type) => !DATA_SCRIPTS.has(type)),
          where,
        )
        .toEqual([]);
      expect.soft(measured.runsCode, `${where}: attributes that run code`).toEqual([]);
      expect.soft(measured.unsized, `${where}: pictures without a width or height`).toEqual([]);
      expect.soft(fetchedTwice(measured.loaded), `${where}: pictures fetched twice`).toEqual([]);
      if (url === home) {
        expect.soft(measured.total, `${where}: everything it loaded`).toBeLessThanOrEqual(HOMEPAGE);
        // Each starter but Blank has a picture at the top of its homepage, so that's the
        // biggest thing on screen there, and the rules for it below are really checked.
        if (starter !== "blank") expect.soft(measured.largest).toHaveProperty("picture");
      }
      if ("picture" in measured.largest) {
        const { bytes, fetchpriority, loading } = measured.largest;
        expect.soft(fetchpriority, `${where}: the biggest picture comes first`).toBe("high");
        expect.soft(loading, `${where}: the biggest picture isn't left for later`).not.toBe("lazy");
        expect.soft(bytes, `${where}: the biggest picture`).toBeGreaterThan(0);
        expect.soft(bytes, `${where}: the biggest picture`).toBeLessThanOrEqual(LARGEST_PICTURE);
      }
    }
  });
}
