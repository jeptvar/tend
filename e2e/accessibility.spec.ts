import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { createEntry, expect, type Site, test } from "./fixtures.ts";

async function expectNoViolations(
  page: Page,
  name: string,
  // A sandboxed frame can't run axe. What goes in one is checked on the public site itself.
  options: { skipFrame?: boolean } = {},
): Promise<void> {
  const builder = new AxeBuilder({ page });
  const results = await (options.skipFrame
    ? builder.setLegacyMode().exclude("iframe")
    : builder
  ).analyze();
  const problems = results.violations.map((violation) => ({
    rule: violation.id,
    where: violation.nodes.map((node) => node.target.join(" ")),
  }));
  expect(problems, name).toEqual([]);
}

/** Everything can be reached and read at the narrowest width the plan asks for. */
async function expectNoSidewaysScrolling(page: Page, name: string): Promise<void> {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth, name).toBeLessThanOrEqual(clientWidth);
}

function text(value: string, marks?: unknown[]) {
  return { type: "text", text: value, ...(marks ? { marks } : {}) };
}

const EVERYTHING = [
  { type: "heading", attrs: { level: 2 }, content: [text("Heading")] },
  { type: "heading", attrs: { level: 3 }, content: [text("Subheading")] },
  { type: "heading", attrs: { level: 4 }, content: [text("Small heading")] },
  {
    type: "paragraph",
    content: [
      text("Words with "),
      text("bold", [{ type: "bold" }]),
      text(", "),
      text("code", [{ type: "code" }]),
      text(" and "),
      text("a link", [{ type: "link", attrs: { href: "https://example.com" } }]),
    ],
  },
  {
    type: "bulletList",
    content: [{ type: "listItem", content: [{ type: "paragraph", content: [text("A point")] }] }],
  },
  {
    type: "orderedList",
    content: [{ type: "listItem", content: [{ type: "paragraph", content: [text("A step")] }] }],
  },
  { type: "blockquote", content: [{ type: "paragraph", content: [text("A quote")] }] },
  { type: "codeBlock", content: [text("some code")] },
  { type: "horizontalRule" },
  { type: "button", attrs: { href: "https://example.com", label: "A button" } },
];

function section(tone: string) {
  return {
    type: "section",
    attrs: { kind: "intro", preset: "1", tone, align: "center" },
    content: [
      { type: "heading", attrs: { level: 2 }, content: [text(`A ${tone} intro`)] },
      {
        type: "paragraph",
        content: [
          text("Words and "),
          text("a link", [{ type: "link", attrs: { href: "https://example.com" } }]),
        ],
      },
      { type: "button", attrs: { href: "https://example.com", label: `${tone} button` } },
    ],
  };
}

/** A published page holding every kind of content, for checking how it all reads. */
async function richPage(page: Page, site: Site, publish = true) {
  const entry = await createEntry(page, site, { type: "page", title: "Everything" });
  const saved = await (
    await page.request.patch(`${site.base}/api/admin/entries/${entry.id}`, {
      headers: { "If-Match": String(entry.rev) },
      data: {
        doc: {
          type: "doc",
          content: [section("none"), section("muted"), section("accent"), ...EVERYTHING],
        },
      },
    })
  ).json();
  if (!publish) return saved;
  return (
    await page.request.post(`${site.base}/api/admin/entries/${entry.id}/publish`, {
      headers: { "If-Match": String(saved.rev) },
      data: {},
    })
  ).json();
}

async function adminScreens(page: Page, site: Site): Promise<[string, string][]> {
  const post = await createEntry(page, site, { title: "A post", publish: true });
  return [
    ["overview", "/admin/"],
    ["posts", "/admin/posts"],
    ["pages", "/admin/pages"],
    ["editor", `/admin/posts/${post.id}`],
  ];
}

for (const colorScheme of ["light", "dark"] as const) {
  test.describe(`in ${colorScheme} mode`, () => {
    test.use({ colorScheme });

    test("setup screens have no accessibility violations", async ({ page, site }) => {
      await page.goto(`${site.base}/admin/setup`);
      await expect(page.getByLabel("Setup code")).toBeVisible();
      await expectNoViolations(page, "code");

      await page.goto(site.link);
      await expectNoViolations(page, "welcome");
      await page.getByRole("link", { name: /Start a new site/ }).click();
      await page.getByRole("button", { name: "Continue" }).click();
      await expect(page.getByText("Type a name for your site")).toBeVisible();
      await expectNoViolations(page, "name, with an error showing");
      await page.getByLabel("Site name").fill("Rise Bakery");
      await page.getByRole("button", { name: "Continue" }).click();
      await page.getByRole("button", { name: "Suggest a passphrase" }).click();
      await expectNoViolations(page, "account");
      await page.getByLabel("Your name").fill("Sam");
      await page.getByLabel("Email").fill("sam@example.com");
      await page.getByRole("button", { name: "Continue" }).click();
      await expect(page.getByRole("radio", { name: /Blog/ })).toBeVisible();
      await expectNoViolations(page, "starting point");
    });

    test("admin screens have no accessibility violations", async ({ page, signedIn }) => {
      for (const [name, path] of await adminScreens(page, signedIn)) {
        await page.goto(`${signedIn.base}${path}`);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        await page.waitForLoadState("networkidle");
        await expectNoViolations(page, name);
      }
    });

    test("the editor has no accessibility violations, whatever's open", async ({
      page,
      signedIn,
    }) => {
      const entry = await richPage(page, signedIn);
      await page.goto(`${signedIn.base}/admin/pages/${entry.id}`);
      const body = page.getByRole("textbox", { name: "Text" });
      await expect(body.locator("h4")).toBeVisible();
      await page.waitForLoadState("networkidle");
      await expectNoViolations(page, "with every kind of content");

      await page.getByText("Address, summary and more").click();
      await expectNoViolations(page, "with the settings open");

      await page.getByRole("button", { name: "Insert +" }).click();
      await expect(page.getByRole("menu")).toBeVisible();
      await expectNoViolations(page, "with the Insert menu open");
      await page.keyboard.press("Escape");

      await body.locator("p").last().click();
      await page.keyboard.press("End");
      await page.keyboard.press("Enter");
      await page.keyboard.type("/");
      await expect(page.getByRole("listbox")).toBeVisible();
      await expectNoViolations(page, 'with the "/" menu open');
      await page.keyboard.press("Escape");
      await page.keyboard.press("Backspace");

      await page.keyboard.press("Shift+ArrowUp");
      await expect(page.getByRole("button", { name: "Underline" })).toBeVisible();
      await expectNoViolations(page, "with the selection toolbar showing");

      await page.keyboard.press("ControlOrMeta+k");
      await expect(page.getByRole("dialog", { name: "Add a link" })).toBeVisible();
      await page.waitForLoadState("networkidle");
      await expectNoViolations(page, "with the link dialog open");
      await page.keyboard.press("Escape");
    });

    test("publishing has no accessibility violations", async ({ page, signedIn }) => {
      const draft = await createEntry(page, signedIn, { type: "page", title: "A draft" });
      const post = await createEntry(page, signedIn, { title: "Reviewed" });
      await page.request.patch(`${signedIn.base}/api/admin/entries/${post.id}`, {
        headers: { "If-Match": String(post.rev) },
        data: {
          doc: {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [
                  text("click here", [{ type: "link", attrs: { href: `entry:${draft.id}` } }]),
                ],
              },
            ],
          },
        },
      });
      await page.goto(`${signedIn.base}/admin/posts/${post.id}`);
      await page.getByRole("button", { name: "Publish post" }).click();
      await expect(page.getByRole("dialog", { name: "Ready to publish?" })).toBeVisible();
      await expectNoViolations(page, "the review");
      await page.getByRole("button", { name: "Publish post now" }).click();
      await expect(page.getByRole("dialog", { name: "Your post is on your site." })).toBeVisible();
      await expectNoViolations(page, "the success screen");
    });

    test("preview and History have no accessibility violations", async ({ page, signedIn }) => {
      const post = await createEntry(page, signedIn, { title: "A post", publish: true });
      await page.goto(`${signedIn.base}/admin/posts/${post.id}`);
      await page.getByRole("button", { name: "Preview" }).click();
      await expect(page.frameLocator("iframe").getByRole("heading", { level: 1 })).toBeVisible();
      await expectNoViolations(page, "preview", { skipFrame: true });
      await page.getByRole("button", { name: "Close" }).click();

      await page.getByRole("button", { name: "History" }).click();
      await page
        .getByRole("dialog", { name: "History" })
        .getByRole("button", { name: /Published/ })
        .click();
      await expect(page.frameLocator("iframe").getByRole("heading", { level: 1 })).toBeVisible();
      await expectNoViolations(page, "History", { skipFrame: true });
    });

    test("the Trash and toasts have no accessibility violations", async ({ page, signedIn }) => {
      const post = await createEntry(page, signedIn, { title: "Binned", publish: true });
      await page.goto(`${signedIn.base}/admin/posts/${post.id}`);
      await page.getByText("Address, summary and more").click();
      await page.getByRole("button", { name: "Move to Trash" }).click();
      await expect(page.getByText("Moved to the Trash")).toBeVisible();
      await expectNoViolations(page, "a toast");
      await page.getByRole("button", { name: "Trash", exact: true }).click();
      await expect(page.getByRole("button", { name: "Delete forever" })).toBeVisible();
      await expectNoViolations(page, "the Trash");
      await page.getByRole("button", { name: "Delete forever" }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await expectNoViolations(page, "the confirmation");
    });

    test("every kind of content reads well on the public site", async ({ page, signedIn }) => {
      const entry = await richPage(page, signedIn);
      await page.goto(`${signedIn.base}${entry.url}`);
      await expect(page.getByRole("link", { name: "accent button" })).toBeVisible();
      await expectNoViolations(page, "a page with everything");
    });

    test("the sign-in screens have no accessibility violations", async ({ page, signedIn }) => {
      await page.goto(`${signedIn.base}/admin/`);
      await page.getByRole("button", { name: "Sign out" }).click();
      await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
      await expectNoViolations(page, "sign in");
      await page.getByRole("link", { name: "Forgot password?" }).click();
      await expect(page.getByRole("heading", { name: "Forgot your password?" })).toBeVisible();
      await expectNoViolations(page, "forgot password");
    });

    test("the public site has no accessibility violations", async ({ page, signedIn }) => {
      const post = await createEntry(page, signedIn, {
        title: "A post",
        body: "Some words.",
        publish: true,
      });
      for (const path of ["/", "/contact", "/blog", post.url as string, "/does-not-exist"]) {
        await page.goto(`${signedIn.base}${path}`);
        await expectNoViolations(page, path);
      }
    });
  });
}

test.describe("at phone widths", () => {
  const UNBROKEN = "averyveryverylongwordwithnospaces".repeat(4);

  test("long unbroken names don't force sideways scrolling, even at 320 px", async ({
    page,
    signedIn,
  }) => {
    const post = await createEntry(page, signedIn, {
      title: UNBROKEN,
      body: UNBROKEN,
      publish: true,
    });
    const about = await createEntry(page, signedIn, {
      type: "page",
      title: UNBROKEN,
      publish: true,
    });
    await page.setViewportSize({ width: 320, height: 640 });
    for (const path of [
      "/admin/",
      "/admin/posts",
      "/admin/pages",
      `/admin/posts/${post.id}`,
      "/",
      "/blog",
      post.url as string,
      about.url as string,
    ]) {
      await page.goto(`${signedIn.base}${path}`);
      await page.waitForLoadState("networkidle");
      await expectNoSidewaysScrolling(page, path);
    }
  });

  /** Links inside written text are exempt in WCAG, because they sit among the words. */
  async function tooSmallTargets(page: Page) {
    return page.evaluate(() =>
      [...document.querySelectorAll("a, button, select, summary")]
        .filter((element) => !element.closest(".tend-prose a, .tend-prose :is(p, li) a"))
        .map((element) => {
          const { width, height } = element.getBoundingClientRect();
          const hidden = getComputedStyle(element).visibility === "hidden";
          return { text: element.textContent, width, height, hidden };
        })
        .filter(({ width, height, hidden }) => !hidden && width > 0 && (width < 44 || height < 44)),
    );
  }

  test("everything tappable in the admin is at least 44 px", async ({ page, signedIn }) => {
    const post = await createEntry(page, signedIn, { title: "A post", publish: true });
    await page.setViewportSize({ width: 375, height: 812 });
    for (const path of ["/admin/", "/admin/posts", `/admin/posts/${post.id}`]) {
      await page.goto(`${signedIn.base}${path}`);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await page.waitForLoadState("networkidle");
      expect(await tooSmallTargets(page), path).toEqual([]);
    }
  });

  test("the editor's controls are all at least 44 px, on a page with everything", async ({
    page,
    signedIn,
  }) => {
    const entry = await richPage(page, signedIn);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`${signedIn.base}/admin/pages/${entry.id}`);
    await expect(page.getByRole("textbox", { name: "Text" }).locator("h4")).toBeVisible();
    await page.getByText("Address, summary and more").click();
    expect(await tooSmallTargets(page), "editor").toEqual([]);

    await page.getByRole("button", { name: "Insert +" }).click();
    expect(await tooSmallTargets(page), "Insert menu").toEqual([]);
    await page.keyboard.press("Escape");

    await page
      .getByRole("button", { name: "Publish changes" })
      .or(page.getByRole("button", { name: "Published" }))
      .first()
      .focus();
    await page.getByRole("button", { name: "History" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.waitForLoadState("networkidle");
    expect(await tooSmallTargets(page), "History").toEqual([]);
  });

  test("the editor's screens fit at 320 px, with long words in them", async ({
    page,
    signedIn,
  }) => {
    const post = await createEntry(page, signedIn, {
      title: UNBROKEN,
      body: UNBROKEN,
      publish: true,
    });
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto(`${signedIn.base}/admin/posts/${post.id}`);
    await page.waitForLoadState("networkidle");
    await page.getByText("Address, summary and more").click();
    await expectNoSidewaysScrolling(page, "settings open");

    const body = page.getByRole("textbox", { name: "Text" });
    await body.click();
    await page.keyboard.press("End");
    await page.keyboard.type(" more");
    await expect(page.getByRole("button", { name: "Publish changes" })).toBeVisible();
    await page.getByRole("button", { name: "Publish changes" }).click();
    await page.getByRole("button", { name: "Preview" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expectNoSidewaysScrolling(page, "preview");
    await page.getByRole("button", { name: "Close" }).click();

    await page.getByRole("button", { name: "History" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expectNoSidewaysScrolling(page, "History");
    await page.getByRole("button", { name: "Close" }).click();

    await body.click();
    await page.keyboard.type(" and more");
    await expect(page.getByRole("button", { name: "Discard changes" })).toBeVisible();
    await page.keyboard.press("ControlOrMeta+k");
    await expect(page.getByRole("dialog", { name: "Add a link" })).toBeVisible();
    await page.waitForLoadState("networkidle");
    await expectNoSidewaysScrolling(page, "link dialog");
  });
});
