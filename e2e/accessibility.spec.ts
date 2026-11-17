import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { createEntry, expect, photo, type Site, test, upload } from "./fixtures.ts";

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

/** Pictures, Picture and text, and Contact & hours with the business details filled in. */
async function pictureContent(page: Page, site: Site) {
  const wide = await upload(page, site, await photo(page, 1600, 900), "wide.jpg");
  const square = await upload(page, site, await photo(page, 800, 800, "#2a6f97"), "square.jpg");
  await page.request.patch(`${site.base}/api/admin/media/${wide.id}`, {
    data: { alt: "The shop from the street", credit: "Photo: Sam Lee" },
  });
  await page.request.patch(`${site.base}/api/admin/media/${square.id}`, {
    data: { decorative: true },
  });
  await page.request.put(`${site.base}/api/admin/settings/business`, {
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
  return [
    { type: "image", attrs: { mediaId: wide.id, caption: "Our first morning", size: "wide" } },
    {
      type: "section",
      attrs: { kind: "pictureText", preset: "1", tone: "muted", align: "left" },
      content: [
        { type: "image", attrs: { mediaId: square.id } },
        { type: "heading", attrs: { level: 2 }, content: [text("Baked here")] },
        { type: "paragraph", content: [text("Everything comes out of our own oven.")] },
      ],
    },
    {
      type: "section",
      attrs: { kind: "contact", preset: "1", tone: "none", align: "left" },
      content: [{ type: "heading", attrs: { level: 2 }, content: [text("Visit us")] }],
    },
  ];
}

/** A published page holding every kind of content, for checking how it all reads. */
async function richPage(page: Page, site: Site, publish = true) {
  const pictures = await pictureContent(page, site);
  const entry = await createEntry(page, site, { type: "page", title: "Everything" });
  const saved = await (
    await page.request.patch(`${site.base}/api/admin/entries/${entry.id}`, {
      headers: { "If-Match": String(entry.rev) },
      data: {
        doc: {
          type: "doc",
          content: [
            section("none"),
            section("muted"),
            section("accent"),
            ...pictures,
            ...EVERYTHING,
          ],
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
  await upload(page, site, await photo(page, 900, 600), "In the library.jpg");
  return [
    ["overview", "/admin/"],
    ["posts", "/admin/posts"],
    ["pages", "/admin/pages"],
    ["editor", `/admin/posts/${post.id}`],
    ["media", "/admin/media"],
    ["site menu", "/admin/menu"],
    ["design", "/admin/design"],
    ["settings: general", "/admin/settings/general"],
    ["settings: business details", "/admin/settings/business"],
    ["settings: search and social", "/admin/settings/search"],
    ["settings: advanced", "/admin/settings/advanced"],
    ["settings: backups", "/admin/settings/backups"],
    ["people", "/admin/people"],
    ["account", "/admin/account"],
  ];
}

for (const colorScheme of ["light", "dark"] as const) {
  test.describe(`in ${colorScheme} mode`, () => {
    test.use({ colorScheme });

    test("setup screens have no accessibility violations", async ({ page, site }) => {
      await page.goto(`${site.base}/admin/setup`);
      await expect(page.getByLabel("Setup code")).toBeVisible();
      await expectNoViolations(page, "code");

      // Only the part after # changes, so the page doesn't load again: the code screen turns
      // into the welcome screen in its own time, and has no heading for a moment in between.
      await page.goto(site.link);
      await expect(page.getByRole("link", { name: /Start a new site/ })).toBeVisible();
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

      await page.goto(`${site.base}/admin/setup/backup`);
      await page.getByRole("button", { name: "Restore this backup" }).click();
      await expect(page.getByText("Choose your backup file.")).toBeVisible();
      await expectNoViolations(page, "start from a backup, with an error showing");
    });

    test("screens for getting in have no accessibility violations", async ({
      page,
      browser,
      signedIn,
    }) => {
      const reply = await page.request.post(`${signedIn.base}/api/admin/people/invites`, {
        data: { email: "ed@example.com", role: "editor" },
      });
      const { token } = await reply.json();
      const context = await browser.newContext({ colorScheme });
      const visitor = await context.newPage();
      await visitor.goto(`${signedIn.base}/admin/invite#${token}`);
      await expect(visitor.getByRole("heading", { name: "Join Rise Bakery" })).toBeVisible();
      await expectNoViolations(visitor, "accepting an invite");
      await visitor.goto(`${signedIn.base}/admin/login/forgot`);
      await expect(visitor.getByRole("link", { name: "Use a recovery code" })).toBeVisible();
      await expectNoViolations(visitor, "forgot password");
      await visitor.getByRole("link", { name: "Use a recovery code" }).click();
      await visitor.getByRole("button", { name: "Continue" }).click();
      await expect(visitor.getByText("Type your email address.")).toBeVisible();
      await expectNoViolations(visitor, "recovery code, with an error showing");
      await visitor.goto(`${signedIn.base}/admin/reset#not-a-real-link-at-all`);
      await expect(visitor.getByRole("heading", { name: "This link can't be used" })).toBeVisible();
      await expectNoViolations(visitor, "a link that can't be used");
      await context.close();
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
      const tag = await (
        await page.request.post(`${signedIn.base}/api/admin/tags`, { data: { name: "News" } })
      ).json();
      const tagged = await createEntry(page, signedIn, { title: "Tagged", body: "Words." });
      await page.request.patch(`${signedIn.base}/api/admin/entries/${tagged.id}`, {
        headers: { "If-Match": String(tagged.rev) },
        data: { tagIds: [tag.id] },
      });
      await page.request.post(`${signedIn.base}/api/admin/entries/${tagged.id}/publish`, {
        headers: { "If-Match": String(tagged.rev + 1) },
        data: {},
      });
      const pictures = await richPage(page, signedIn);
      for (const path of [
        "/",
        "/contact",
        "/blog",
        post.url as string,
        pictures.url as string,
        "/tag/news",
        "/does-not-exist",
      ]) {
        await page.goto(`${signedIn.base}${path}`);
        await expectNoViolations(page, path);
      }
    });

    test("the Coming soon page has no accessibility violations", async ({
      page,
      signedIn,
      browser,
    }) => {
      await page.request.put(`${signedIn.base}/api/admin/settings/visibility`, {
        data: { mode: "coming_soon" },
      });
      const stranger = await (await browser.newContext({ colorScheme })).newPage();
      await stranger.goto(`${signedIn.base}/`);
      await expect(stranger.getByText("This site is coming soon.")).toBeVisible();
      await expectNoViolations(stranger, "coming soon");
    });

    test("Media's details and the picture dialogs have no accessibility violations", async ({
      page,
      signedIn,
    }) => {
      await upload(page, signedIn, await photo(page, 900, 600), "Counter.jpg");
      await page.goto(`${signedIn.base}/admin/media`);
      await page.getByRole("button", { name: /Counter\.jpg/ }).click();
      await expect(page.getByRole("dialog", { name: "Counter.jpg" })).toBeVisible();
      await expectNoViolations(page, "media details");
      await page.getByRole("button", { name: "Close" }).click();

      const post = await createEntry(page, signedIn, { title: "Pictures", body: "" });
      await page.goto(`${signedIn.base}/admin/posts/${post.id}`);
      await page.getByRole("button", { name: "Insert +" }).click();
      await page.getByRole("menuitem", { name: "Image" }).click();
      await expect(page.getByRole("dialog", { name: "Add an image" })).toBeVisible();
      await page.waitForLoadState("networkidle");
      await expectNoViolations(page, "image picker");
      await page
        .getByRole("dialog", { name: "Add an image" })
        .getByRole("button", { name: /Counter/ })
        .click();
      await expect(page.getByRole("dialog", { name: "Describe this image" })).toBeVisible();
      await expectNoViolations(page, "describe this image");
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
    const rich = await richPage(page, signedIn);
    await upload(page, signedIn, await photo(page, 900, 600), `${UNBROKEN}.jpg`);
    await page.setViewportSize({ width: 320, height: 640 });
    for (const path of [
      "/admin/",
      "/admin/posts",
      "/admin/pages",
      `/admin/posts/${post.id}`,
      "/admin/media",
      "/admin/menu",
      "/admin/design",
      "/admin/settings/general",
      "/admin/settings/business",
      "/admin/settings/search",
      "/",
      "/blog",
      "/contact",
      post.url as string,
      about.url as string,
      rich.url as string,
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
    await upload(page, signedIn, await photo(page, 900, 600), "Counter.jpg");
    for (const path of [
      "/admin/",
      "/admin/posts",
      `/admin/posts/${post.id}`,
      "/admin/media",
      "/admin/menu",
      "/admin/design",
      "/admin/settings/general",
      "/admin/settings/business",
      "/admin/settings/search",
      "/admin/settings/advanced",
    ]) {
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
