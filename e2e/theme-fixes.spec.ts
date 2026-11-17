import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import {
  createEntry,
  expect,
  photo,
  type Site,
  tabReachesLinks,
  test,
  upload,
} from "./fixtures.ts";

// The Meadow theme, measured in a real browser: what visitors can read, see and reach.

function text(value: string, marks?: unknown[]) {
  return { type: "text", text: value, ...(marks ? { marks } : {}) };
}

const paragraph = (...content: unknown[]) => ({ type: "paragraph", content });
const heading = (level: number, words: string) => ({
  type: "heading",
  attrs: { level },
  content: [text(words)],
});
const link = (words: string, href: string) => text(words, [{ type: "link", attrs: { href } }]);
const picture = (mediaId: string, caption?: string, size = "normal") => ({
  type: "image",
  attrs: { mediaId, alt: "A loaf", size, ...(caption ? { caption } : {}) },
});
const section = (kind: string, tone: string, content: unknown[], preset = "1") => ({
  type: "section",
  attrs: { kind, preset, tone, align: "left" },
  content,
});

/** Publishes a page holding these blocks, and gives its address. */
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

/** Red, green and blue from a computed colour, as rgb() or color(srgb ...) gives them. */
function channels(color: string): [number, number, number] {
  const numbers = (color.match(/[\d.]+/g) ?? []).map(Number);
  const scale = color.startsWith("color(") ? 255 : 1;
  return [numbers[0] ?? 0, numbers[1] ?? 0, numbers[2] ?? 0].map((value) => value * scale) as [
    number,
    number,
    number,
  ];
}

/** WCAG 2.2's contrast ratio between two opaque colours. */
function contrast(first: string, second: string): number {
  const luminance = (color: string) => {
    const [r, g, b] = channels(color).map((value) => {
      const c = value / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [light, dark] = [luminance(first), luminance(second)].sort((a, b) => b - a) as [
    number,
    number,
  ];
  return (light + 0.05) / (dark + 0.05);
}

type Box = { left: number; top: number; right: number; bottom: number };

/** How much of two boxes is the same area of the screen, in square pixels. */
function overlap(a: Box, b: Box): number {
  const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return Math.max(0, width) * Math.max(0, height);
}

for (const colorScheme of ["light", "dark"] as const) {
  test.describe(`on the accent colour, in ${colorScheme} mode`, () => {
    test.use({ colorScheme });

    test("captions, credits and quotes can be read", async ({ page, signedIn }) => {
      const ovens = await upload(page, signedIn, await photo(page, 1200, 800), "ovens.jpg");
      await page.request.patch(`${signedIn.base}/api/admin/media/${ovens.id}`, {
        data: { credit: "Photo: Ana Cruz" },
      });
      const url = await publishPage(page, signedIn, "Our ovens", [
        section("pictureText", "accent", [
          picture(ovens.id, "Our ovens at five in the morning"),
          heading(2, "Baked fresh"),
          paragraph(text("Every morning, before sunrise.")),
          { type: "blockquote", content: [paragraph(text("The best bread in town."))] },
        ]),
      ]);
      await page.goto(`${signedIn.base}${url}`);
      const colours = await page.evaluate(() => {
        const accent = document.querySelector(".t-tone-accent") as HTMLElement;
        const colourOf = (selector: string) =>
          getComputedStyle(accent.querySelector(selector) as HTMLElement).color;
        return {
          background: getComputedStyle(accent).backgroundColor,
          caption: colourOf("figcaption"),
          credit: colourOf(".t-credit"),
          quote: colourOf("blockquote p"),
        };
      });
      for (const part of ["caption", "credit", "quote"] as const) {
        expect(contrast(colours[part], colours.background), part).toBeGreaterThanOrEqual(4.5);
      }
    });

    test("keyboard focus shows on every link and button", async ({ page, signedIn }) => {
      // The focus styles are the theme's own CSS, the same in every browser, so a browser
      // whose Tab skips links can leave them to the others.
      test.skip(!(await tabReachesLinks(page)), "Tab doesn't move to links in this browser");
      await setBusinessDetails(page, signedIn);
      const url = await publishPage(page, signedIn, "Find us", [
        section("intro", "accent", [
          heading(2, "Welcome"),
          paragraph(text("Come and say hello. "), link("Read more", "https://example.com/more")),
          { type: "button", attrs: { href: "https://example.com/visit", label: "Find us" } },
        ]),
        section("contact", "accent", [heading(2, "Visit us")]),
      ]);
      await page.goto(`${signedIn.base}${url}`);
      const reachable = await page.locator(".t-tone-accent a").count();
      expect(reachable).toBe(5);

      // Tabs through the whole page, the way someone using a keyboard would.
      const focused = new Map<
        string,
        { visible: boolean; style: string; width: number; ring: number }
      >();
      for (let press = 0; press < 40; press++) {
        await page.keyboard.press("Tab");
        const now = await page.evaluate(() => {
          const element = document.activeElement as HTMLElement;
          const accent = element.closest(".t-tone-accent");
          if (!accent) return null;
          const style = getComputedStyle(element);
          return {
            name: element.textContent ?? "",
            visible: element.matches(":focus-visible"),
            style: style.outlineStyle,
            width: Number.parseFloat(style.outlineWidth),
            colour: style.outlineColor,
            behind: getComputedStyle(accent).backgroundColor,
          };
        });
        if (!now) continue;
        focused.set(now.name, {
          visible: now.visible,
          style: now.style,
          width: now.width,
          ring: contrast(now.colour, now.behind),
        });
      }
      expect(focused.size).toBe(reachable);
      for (const [name, focus] of focused) {
        expect(focus.visible, name).toBe(true);
        expect(focus.style, name).not.toBe("none");
        expect(focus.width, name).toBeGreaterThanOrEqual(2);
        expect(
          focus.ring,
          `${name}: the outline against the colour behind it`,
        ).toBeGreaterThanOrEqual(3);
      }
    });
  });
}

test.describe("pictures", () => {
  test("two pictures in one Picture and text section never cover each other", async ({
    page,
    signedIn,
  }) => {
    const first = await upload(page, signedIn, await photo(page, 1200, 800), "first.jpg");
    const second = await upload(
      page,
      signedIn,
      await photo(page, 1200, 800, "#2a6f97"),
      "second.jpg",
    );
    // Both ways round: the pictures on the left, and on the right.
    const twoPictures = (preset: string) =>
      section(
        "pictureText",
        "none",
        [
          picture(first.id, `First picture ${preset}`),
          picture(second.id, `Second picture ${preset}`),
          heading(2, `Baked here ${preset}`),
          paragraph(text("Everything comes out of our own oven.")),
        ],
        preset,
      );
    const url = await publishPage(page, signedIn, "Two pictures", [
      twoPictures("1"),
      twoPictures("2"),
    ]);
    for (const width of [1200, 800]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${signedIn.base}${url}`);
      const sections = await page.evaluate(() =>
        [...document.querySelectorAll(".t-picture-text")].map((holder) =>
          [...holder.children].map((element) => {
            const { left, top, right, bottom } = element.getBoundingClientRect();
            return { name: element.textContent ?? "", left, top, right, bottom };
          }),
        ),
      );
      expect(sections).toHaveLength(2);
      for (const boxes of sections) {
        expect(boxes).toHaveLength(4);
        for (const [index, box] of boxes.entries()) {
          expect(box.right - box.left, box.name).toBeGreaterThan(0);
          for (const other of boxes.slice(index + 1)) {
            expect(overlap(box, other), `${box.name} and ${other.name} at ${width} px`).toBe(0);
          }
        }
        // The words are still beside the pictures, starting next to the first one.
        const [firstPicture, words] = [boxes[0] as Box, boxes[2] as Box];
        expect(words.top, `${width} px`).toBeLessThan(firstPicture.bottom);
      }
    }
  });

  test("a Picture and text section whose picture is in the Trash gives its words the whole width", async ({
    page,
    signedIn,
  }) => {
    const gone = await upload(page, signedIn, await photo(page, 1200, 800), "gone.jpg");
    const url = await publishPage(page, signedIn, "Picture gone", [
      section("pictureText", "none", [
        picture(gone.id, "Soon gone"),
        heading(2, "Baked here"),
        paragraph(text("Everything comes out of our own oven, every single morning.")),
      ]),
    ]);
    const trashed = await page.request.post(`${signedIn.base}/api/admin/media/${gone.id}/trash`, {
      data: {},
    });
    expect(trashed.status()).toBe(200);
    await page.setViewportSize({ width: 1200, height: 900 });
    await page.goto(`${signedIn.base}${url}`);
    await expect(page.locator(".t-picture-text figure")).toHaveCount(0);
    const { content, words } = await page.evaluate(() => {
      const holder = document.querySelector(".t-picture-text") as HTMLElement;
      const box = holder.getBoundingClientRect();
      const style = getComputedStyle(holder);
      const left = box.left + Number.parseFloat(style.paddingLeft);
      const right = box.right - Number.parseFloat(style.paddingRight);
      return {
        content: { left, right },
        words: [...holder.children].map((element) => {
          const { left: start, right: end } = element.getBoundingClientRect();
          return { name: element.tagName, left: start, right: end };
        }),
      };
    });
    expect(words.map((word) => word.name)).toEqual(["H2", "P"]);
    for (const word of words) {
      expect(word.left, word.name).toBeCloseTo(content.left, 0);
      expect(word.right, word.name).toBeCloseTo(content.right, 0);
    }
  });

  test("a small picture isn't stretched past its own size, and a big one still fills the column", async ({
    page,
    signedIn,
  }) => {
    const badge = await upload(page, signedIn, await photo(page, 160, 160, "#aa3333"), "badge.jpg");
    const big = await upload(page, signedIn, await photo(page, 1200, 800), "big.jpg");
    const wide = await upload(page, signedIn, await photo(page, 1600, 900), "wide.jpg");
    const url = await publishPage(page, signedIn, "Sizes", [
      paragraph(text("A small badge follows.")),
      picture(badge.id),
      picture(big.id, "Big"),
      picture(wide.id, "Wide", "wide"),
      picture(badge.id, "Full width, as asked", "full"),
    ]);
    for (const width of [1200, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${signedIn.base}${url}`);
      const shown = await page.evaluate(() => {
        const column = (document.querySelector(".t-body") as HTMLElement).getBoundingClientRect();
        return {
          column: column.width,
          window: document.documentElement.clientWidth,
          pictures: [...document.querySelectorAll(".t-image")].map((figure) => {
            const image = figure.querySelector("img") as HTMLImageElement;
            const box = image.getBoundingClientRect();
            return {
              width: box.width,
              height: box.height,
              frame: figure.getBoundingClientRect().width,
              natural: Number(image.getAttribute("width")) / Number(image.getAttribute("height")),
            };
          }),
        };
      });
      type Shown = (typeof shown.pictures)[number];
      const [small, large, wider, full] = shown.pictures as [Shown, Shown, Shown, Shown];
      expect(small.width, `the badge at ${width} px`).toBeLessThanOrEqual(160);
      expect(small.width, `the badge at ${width} px`).toBeGreaterThan(150);
      expect(large.width, `the big picture at ${width} px`).toBeCloseTo(shown.column, 0);
      expect(wider.width, `the wide picture at ${width} px`).toBeCloseTo(wider.frame, 0);
      expect(full.width, `the full-width picture at ${width} px`).toBeCloseTo(shown.window, 0);
      for (const each of shown.pictures) {
        expect(each.width / each.height).toBeCloseTo(each.natural, 1);
      }
    }
  });

  test("a wide logo keeps its shape on a phone", async ({ page, signedIn }) => {
    const logo = await upload(page, signedIn, await photo(page, 800, 100, "#1f6f4a"), "logo.jpg");
    const design = await (await page.request.get(`${signedIn.base}/api/admin/design`)).json();
    const saved = await page.request.put(`${signedIn.base}/api/admin/design`, {
      data: { ...design.value, logoId: logo.id },
    });
    expect(saved.status()).toBe(200);
    for (const width of [320, 375, 414, 768, 1200]) {
      await page.setViewportSize({ width, height: 700 });
      await page.goto(`${signedIn.base}/`);
      const shown = await page.evaluate(() => {
        const image = document.querySelector(".t-brand img") as HTMLImageElement;
        const { width: across, height: down, right } = image.getBoundingClientRect();
        return {
          across,
          down,
          right,
          window: document.documentElement.clientWidth,
          scrolls: document.documentElement.scrollWidth,
        };
      });
      expect(shown.across / shown.down, `the logo's shape at ${width} px`).toBeCloseTo(8, 1);
      expect(shown.down, `the logo's height at ${width} px`).toBeLessThanOrEqual(48.5);
      expect(shown.right, `the logo at ${width} px`).toBeLessThanOrEqual(shown.window);
      expect(shown.scrolls, `sideways scrolling at ${width} px`).toBeLessThanOrEqual(shown.window);
      // Where there's room, it's as tall as the header allows.
      if (width >= 414) expect(shown.down).toBeCloseTo(48, 0);
    }
  });
});

/** The page's 1rem gutter, less half a pixel for rounding: no open list comes nearer the edge. */
const GUTTER = 16 - 0.5;

const STYLES = ["with anchor positioning", "without anchor positioning"] as const;

/**
 * theme.css as a browser without anchor positioning reads it, as Safari and Firefox did before
 * they had it: the @supports blocks that ask for it are left out, and any meant for browsers
 * without it are kept.
 */
function withoutAnchorPositioning(css: string): string {
  let rest = css;
  for (;;) {
    const found = /@supports\s+([^{]*anchor[^{]*)\{/.exec(rest);
    if (!found) return rest;
    const open = found.index + found[0].length - 1;
    let close = open;
    for (let depth = 0; close < rest.length; close++) {
      if (rest[close] === "{") depth++;
      else if (rest[close] === "}" && --depth === 0) break;
    }
    const kept = found[1]?.trim().startsWith("not") ? rest.slice(open + 1, close) : "";
    rest = rest.slice(0, found.index) + kept + rest.slice(close + 1);
  }
}

/** Whether the page's menu is laid out with anchor positioning: Chromium can, so it's up to the CSS. */
function usesAnchorPositioning(page: Page): Promise<boolean> {
  return page.evaluate(
    () =>
      CSS.supports("anchor-scope: all") &&
      [...document.styleSheets]
        .flatMap((sheet) => [...sheet.cssRules])
        .some((rule) => /anchor|position-area|position-try/.test(rule.cssText)),
  );
}

/** Each open list and the link that opened it, against the window. */
function openLists(page: Page) {
  return page.evaluate(() => {
    const box = (element: Element) => {
      const { left, right, top, bottom } = element.getBoundingClientRect();
      return { left, right, top, bottom };
    };
    return {
      window: document.documentElement.clientWidth,
      scrolls: document.documentElement.scrollWidth,
      lists: [...document.querySelectorAll(".t-dropdown[open]")].map((dropdown) => ({
        link: box(dropdown.querySelector("summary") as Element),
        list: box(dropdown.querySelector(".t-submenu") as Element),
        links: [...dropdown.querySelectorAll(".t-submenu a")].map(box),
      })),
    };
  });
}

/** Every open list is on screen, clear of the window's edges, and under its own link. */
function expectOnScreen(shown: Awaited<ReturnType<typeof openLists>>, name: string): void {
  expect(shown.lists.length, `${name}: an open list`).toBeGreaterThan(0);
  for (const { link, list, links } of shown.lists) {
    for (const each of [list, ...links]) {
      expect(each.left, `${name}: the gap on the left`).toBeGreaterThanOrEqual(GUTTER);
      expect(shown.window - each.right, `${name}: the gap on the right`).toBeGreaterThanOrEqual(
        GUTTER,
      );
    }
    expect(list.top, `${name}: the list is under its link`).toBeGreaterThanOrEqual(link.bottom - 1);
    expect(list.left, `${name}: the list is under its link`).toBeLessThan(link.right);
    expect(list.right, `${name}: the list is under its link`).toBeGreaterThan(link.left);
  }
  expect(shown.scrolls, `${name}: the page scrolls sideways`).toBeLessThanOrEqual(shown.window);
}

test.describe("the site menu", () => {
  const child = (label: string) => ({
    id: label.toLowerCase().replace(/\W+/g, "-"),
    label,
    target: { type: "url", url: `/${label.toLowerCase().replace(/\W+/g, "-")}` },
  });
  const dropdown = (label: string, children: string[]) => ({
    ...child(label),
    children: children.map(child),
  });
  const plain = (label: string) => ({ ...child(label), children: [] });
  const more = dropdown("More", ["Wholesale and catering", "Gift cards"]);
  const MENUS = {
    "the last link": [plain("About"), plain("Contact"), more],
    "next to a short last link": [plain("About"), more, plain("FAQ")],
    "the first of many": [
      more,
      plain("About"),
      plain("Our story"),
      plain("Hours"),
      plain("Contact"),
    ],
  };
  const WIDTHS = [320, 375, 744, 768, 810, 820, 834, 900, 1024, 1280];
  /** Tablets, upright and on their side, where a list can reach either edge. */
  const TABLETS = [744, 768, 820, 834, 900, 1024];

  /** Menus of 2 to 8 links with the dropdown first, in the middle and last, and one with two. */
  const ORDERS: [string, unknown[]][] = [
    [
      "two dropdowns, first and last",
      [more, plain("About"), dropdown("Shop", ["Bread boxes", "Hampers"])],
    ],
  ];
  const OTHERS = ["About", "Contact", "FAQ", "Our story", "Hours", "Gallery", "Find us"];
  for (const count of [2, 3, 5, 8]) {
    const others = OTHERS.slice(0, count - 1).map(plain);
    const places = { first: 0, "in the middle": Math.floor(count / 2), last: count - 1 };
    for (const [where, at] of Object.entries(places)) {
      if (count === 2 && where === "in the middle") continue;
      ORDERS.push([
        `${count} links, the dropdown ${where}`,
        [...others.slice(0, at), more, ...others.slice(at)],
      ]);
    }
  }

  async function setHeader(page: Page, site: Site, header: string): Promise<void> {
    const design = await (await page.request.get(`${site.base}/api/admin/design`)).json();
    const saved = await page.request.put(`${site.base}/api/admin/design`, {
      data: { ...design.value, theme: { ...design.value.theme, header } },
    });
    expect(saved.status()).toBe(200);
  }

  async function setMenu(page: Page, site: Site, items: unknown[]): Promise<void> {
    const saved = await page.request.put(`${site.base}/api/admin/menus/main`, {
      data: { items },
    });
    expect(saved.status()).toBe(200);
  }

  for (const style of STYLES) {
    test.describe(style, () => {
      test.beforeEach(async ({ page }) => {
        if (style === "with anchor positioning") return;
        await page.route("**/theme.css", async (route) => {
          const response = await route.fetch();
          await route.fulfill({ response, body: withoutAnchorPositioning(await response.text()) });
        });
      });

      /** Opens the page at this size, and every dropdown in its menu, as a visitor would. */
      async function openAll(page: Page, url: string, size: { width: number; height: number }) {
        await page.setViewportSize(size);
        await page.goto(url);
        expect(await usesAnchorPositioning(page), style).toBe(style === "with anchor positioning");
        // The last first, so an open list never covers a link still to be opened.
        for (const summary of (await page.locator(".t-dropdown summary").all()).reverse()) {
          await summary.click();
        }
      }

      test("an open dropdown stays on screen at every width, wherever it is in the menu", async ({
        page,
        signedIn,
      }) => {
        for (const header of ["simple", "centered"]) {
          await setHeader(page, signedIn, header);
          for (const [where, items] of Object.entries(MENUS)) {
            await setMenu(page, signedIn, items);
            await openAll(page, `${signedIn.base}/`, { width: WIDTHS[0] as number, height: 700 });
            // It stays open while the window changes size, like a tablet turned on its side.
            for (const width of WIDTHS) {
              await page.setViewportSize({ width, height: 700 });
              const name = `${header} header, ${where}, at ${width} px`;
              await expect(page.getByRole("link", { name: "Gift cards" }), name).toBeVisible();
              expectOnScreen(await openLists(page), name);
            }
          }
        }
      });

      for (const header of ["simple", "centered"]) {
        test(`every dropdown stays on screen, with the menu's links in any order (${header} header)`, async ({
          page,
          signedIn,
        }) => {
          test.setTimeout(120_000);
          await setHeader(page, signedIn, header);
          for (const [where, items] of ORDERS) {
            await setMenu(page, signedIn, items);
            for (const width of TABLETS) {
              await openAll(page, `${signedIn.base}/`, { width, height: 700 });
              expectOnScreen(await openLists(page), `${where}, at ${width} px`);
            }
          }
        });
      }

      test("a list with a long link name keeps clear of the window's edges", async ({
        page,
        signedIn,
      }) => {
        test.setTimeout(90_000);
        const long = dropdown("More", [
          "Wholesale, catering and private events for weddings",
          "Gift cards",
        ]);
        const menus = {
          first: [long, plain("About"), plain("Contact")],
          "in the middle": [plain("About"), long, plain("FAQ")],
          last: [plain("About"), plain("Contact"), long],
        };
        for (const header of ["simple", "centered"]) {
          await setHeader(page, signedIn, header);
          for (const [where, items] of Object.entries(menus)) {
            await setMenu(page, signedIn, items);
            for (const width of [744, 900, 1024, 1280, 1600]) {
              await openAll(page, `${signedIn.base}/`, { width, height: 700 });
              expectOnScreen(await openLists(page), `${header} header, ${where}, at ${width} px`);
            }
          }
        }
      });

      test("a long list on a short page, or a phone on its side, stays on screen and every link in it can be reached", async ({
        page,
        signedIn,
      }) => {
        const tabsToLinks = await tabReachesLinks(page);
        const SIZES = [
          { width: 844, height: 390, links: 8 },
          { width: 915, height: 412, links: 8 },
          { width: 768, height: 500, links: 10 },
        ];
        for (const header of ["simple", "centered"]) {
          await setHeader(page, signedIn, header);
          for (const { width, height, links } of SIZES) {
            const items = Array.from({ length: links }, (_, index) => `Item number ${index + 1}`);
            await setMenu(page, signedIn, [
              plain("About"),
              plain("Contact"),
              dropdown("More", items),
            ]);
            const name = `${header} header, ${links} links at ${width}x${height}`;
            // The starting point's homepage is shorter than the list.
            await openAll(page, `${signedIn.base}/`, { width, height });
            expectOnScreen(await openLists(page), name);
            // Tabbing through it brings each link into view, whole, with nothing over it, in a
            // browser whose Tab moves to links. The list's place on screen and its accessibility
            // are checked in every browser.
            const walk = tabsToLinks ? ["More", ...items] : [];
            await page.locator(".t-dropdown summary").focus();
            for (const label of walk) {
              await page.keyboard.press("Tab");
              const focused = await page.evaluate(() => {
                const element = document.activeElement as HTMLElement;
                const { left, right, top, bottom } = element.getBoundingClientRect();
                const middle = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
                const { clientWidth, clientHeight } = document.documentElement;
                return {
                  label: element.textContent,
                  inView: top >= 0 && left >= 0 && bottom <= clientHeight && right <= clientWidth,
                  uncovered: middle?.closest("a") === element,
                };
              });
              expect(focused, `${name}: ${label}`).toEqual({
                label,
                inView: true,
                uncovered: true,
              });
            }
            expectOnScreen(await openLists(page), `${name}, at its last link`);
            const results = await new AxeBuilder({ page }).analyze();
            expect(
              results.violations.map((violation) => violation.id),
              `${name}: accessibility`,
            ).toEqual([]);
          }
        }
      });
    });
  }
});

test.describe("business details", () => {
  /** Every heading in the order it's read, so a missing level shows as a gap. */
  async function outline(page: Page): Promise<string[]> {
    return page.evaluate(() =>
      [...document.querySelectorAll("h1, h2, h3, h4, h5, h6")].map(
        (element) => `${element.tagName.toLowerCase()} ${element.textContent?.trim()}`,
      ),
    );
  }

  async function expectNoMissingLevel(page: Page, name: string): Promise<void> {
    const headings = await outline(page);
    const levels = headings.map((line) => Number(line[1]));
    expect(levels[0], `${name}: ${headings.join(", ")}`).toBe(1);
    for (const [index, level] of levels.entries()) {
      if (index === 0) continue;
      expect(level, `${name}: ${headings.join(", ")}`).toBeLessThanOrEqual(
        (levels[index - 1] as number) + 1,
      );
    }
    const results = await new AxeBuilder({ page }).withRules(["heading-order"]).analyze();
    expect(results.violations, name).toEqual([]);
  }

  test("headings follow on from the page's own, wherever they're shown", async ({
    page,
    signedIn,
    browser,
  }) => {
    await setBusinessDetails(page, signedIn);
    // As the editor inserts it, with its heading left blank.
    const bare = await publishPage(page, signedIn, "Find us", [
      paragraph(text("Come and see us.")),
      section("contact", "none", [{ type: "heading", attrs: { level: 2 } }, { type: "paragraph" }]),
    ]);
    const both = await publishPage(page, signedIn, "Two ways in", [
      section("contact", "muted", [heading(2, "Visit us")]),
      heading(2, "More about us"),
      section("contact", "accent", [paragraph(text("Or just drop in."))]),
      section("contact", "none", [heading(3, "Opening times")]),
    ]);
    const levels = async (path: string) => {
      await page.goto(`${signedIn.base}${path}`);
      await expect(page.locator(".t-footer-business")).toBeVisible();
      await expectNoMissingLevel(page, path);
      return page.evaluate(() =>
        [...document.querySelectorAll(".t-business")].map((details) =>
          [...details.querySelectorAll("h2, h3, h4, h5, h6")].map((each) => each.tagName),
        ),
      );
    };
    expect(await levels(bare)).toEqual([["H2", "H2", "H2"]]);
    expect(await levels("/contact")).toEqual([["H3", "H3", "H3"]]);
    expect(await levels(both)).toEqual([
      ["H3", "H3", "H3"],
      ["H2", "H2", "H2"],
      ["H4", "H4", "H4"],
    ]);
    await levels("/");

    await page.request.put(`${signedIn.base}/api/admin/settings/visibility`, {
      data: { mode: "coming_soon" },
    });
    const stranger = await (await browser.newContext()).newPage();
    await stranger.goto(`${signedIn.base}/`);
    await expect(stranger.getByText("This site is coming soon.")).toBeVisible();
    await expectNoMissingLevel(stranger, "coming soon");
    expect(
      await stranger.evaluate(() =>
        [...document.querySelectorAll(".t-business :is(h2, h3, h4)")].map((each) => each.tagName),
      ),
    ).toEqual(["H2", "H2", "H2"]);
  });
});
