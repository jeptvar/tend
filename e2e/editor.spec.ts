import type { Page, Route } from "@playwright/test";
import {
  bodyText,
  closeWhileDown,
  createEntry,
  expect,
  readEntry,
  type Site,
  signIn,
  test,
} from "./fixtures.ts";

const SAVE_PATH = "**/api/admin/entries/*";

function isSave(route: Route): boolean {
  return route.request().method() === "PATCH";
}

/** Holds saves back for a while, like a slow connection. */
async function slowSaves(page: Page, delayMs: number): Promise<void> {
  await page.route(SAVE_PATH, async (route) => {
    if (isSave(route)) await new Promise((resolve) => setTimeout(resolve, delayMs));
    await route.fallback();
  });
}

/** Makes saves fail, like a dropped connection. */
async function failSaves(page: Page): Promise<void> {
  await page.route(SAVE_PATH, (route) => (isSave(route) ? route.abort() : route.fallback()));
}

const body = (page: Page) => page.getByRole("textbox", { name: "Text" });
const saveStatus = (page: Page) => page.getByTestId("save-status");
const postsLink = (page: Page) => page.getByRole("link", { name: "Posts", exact: true });

async function openPost(page: Page, site: Site, id: string): Promise<void> {
  await page.goto(`${site.base}/admin/posts/${id}`);
  await expect(body(page)).toBeVisible();
}

/** What's kept on this device. */
function heldRows(page: Page): Promise<{ key: string; userId: string; heldAt: number }[]> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open("tend");
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    return new Promise((resolve) => {
      const all = db.transaction("drafts").objectStore("drafts").getAll();
      all.onsuccess = () => resolve(all.result);
    });
  });
}

async function openSettings(page: Page): Promise<void> {
  const summary = page.getByText("Address, summary and more");
  await summary.scrollIntoViewIfNeeded();
  if ((await page.locator("details[open]").count()) === 0) await summary.click();
}

/** Selects everything and types over it, the way a person would. */
async function retype(page: Page, words: string): Promise<void> {
  await body(page).click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type(words);
}

test.describe("writing", () => {
  test("write, publish and view a post, starting from the overview", async ({ page, signedIn }) => {
    await page.goto(`${signedIn.base}/admin/`);
    await page.getByRole("button", { name: "Write a post" }).click();

    await expect(page.getByLabel("Title", { exact: true })).toBeFocused();
    await page.getByLabel("Title", { exact: true }).fill("Sourdough is back");
    await page.keyboard.press("Enter");
    await expect(body(page)).toBeFocused();
    await page.keyboard.type("We bake on Saturday.");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Come early <b>please</b>.");
    await expect(saveStatus(page)).toHaveText("Saved", { timeout: 5000 });

    await page.getByRole("button", { name: "Publish post" }).click();
    const review = page.getByRole("dialog", { name: "Ready to publish?" });
    await expect(review.getByText(`${signedIn.base}/blog/sourdough-is-back`)).toBeVisible();
    await review.getByRole("button", { name: "Publish post now" }).click();

    const done = page.getByRole("dialog", { name: "Your post is on your site." });
    await expect(done).toBeVisible();
    await expect(done.getByRole("heading")).toBeFocused();
    await expect(done.getByRole("link", { name: "View post" })).toHaveAttribute(
      "href",
      `${signedIn.base}/blog/sourdough-is-back`,
    );
    await done.getByRole("button", { name: "Keep editing" }).click();
    await expect(saveStatus(page)).toContainText("On your site");

    const visitor = await page.context().newPage();
    await visitor.goto(`${signedIn.base}/blog/sourdough-is-back`);
    await expect(visitor.getByRole("heading", { name: "Sourdough is back" })).toBeVisible();
    await expect(visitor.getByText("Come early <b>please</b>.")).toBeVisible();
    await visitor.goto(`${signedIn.base}/`);
    await expect(visitor.getByRole("link", { name: "Blog" })).toBeVisible();
  });

  test("Write another starts a fresh one", async ({ page, signedIn }) => {
    const post = await createEntry(page, signedIn, { title: "First" });
    await openPost(page, signedIn, post.id);
    await page.getByRole("button", { name: "Publish post" }).click();
    await page.getByRole("button", { name: "Publish post now" }).click();
    await page.getByRole("button", { name: "Write another" }).click();
    await expect(page.getByLabel("Title", { exact: true })).toHaveValue("");
    await expect(page).not.toHaveURL(new RegExp(post.id));
  });

  test("changes stay off the site until published, and the wording says so", async ({
    page,
    signedIn,
  }) => {
    const post = await createEntry(page, signedIn, { title: "Hours", publish: true });
    await openPost(page, signedIn, post.id);
    await expect(saveStatus(page)).toContainText("On your site");

    await retype(page, "Closed on Monday");
    await expect(saveStatus(page)).toContainText("Changes saved, not on your site yet", {
      timeout: 5000,
    });
    expect(await (await page.request.get(`${signedIn.base}${post.url}`)).text()).not.toContain(
      "Closed on Monday",
    );

    // Routine, with nothing to warn about, so it goes straight through.
    await page.getByRole("button", { name: "Publish changes" }).click();
    await expect(saveStatus(page)).toContainText("On your site");
    expect(await (await page.request.get(`${signedIn.base}${post.url}`)).text()).toContain(
      "Closed on Monday",
    );
  });

  test("typing back to what's on the site means nothing's waiting", async ({ page, signedIn }) => {
    const post = await createEntry(page, signedIn, { title: "Hours", body: "Open", publish: true });
    await openPost(page, signedIn, post.id);
    await retype(page, "Closed");
    await expect(saveStatus(page)).toContainText("not on your site yet", { timeout: 5000 });
    await retype(page, "Open");
    await expect(saveStatus(page)).toContainText("On your site", { timeout: 5000 });
    await expect(page.getByRole("button", { name: "Publish changes" })).toHaveCount(0);
  });

  test("the homepage can be edited, and has no address or Trash", async ({ page, signedIn }) => {
    await page.goto(`${signedIn.base}/admin/`);
    await page.getByRole("link", { name: "Edit homepage" }).click();
    await expect(body(page)).toBeVisible();
    await openSettings(page);
    await expect(page.getByLabel("Page address")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Move to Trash" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Unpublish" })).toHaveCount(0);
  });

  test("an address someone else has can be fixed from the review", async ({ page, signedIn }) => {
    await createEntry(page, signedIn, { title: "Same", publish: true });
    const second = await createEntry(page, signedIn, { title: "Same" });
    await openPost(page, signedIn, second.id);

    await page.getByRole("button", { name: "Publish post" }).click();
    const review = page.getByRole("dialog", { name: "Ready to publish?" });
    await expect(review.getByText("Try same-2.")).toBeVisible();
    await expect(review.getByRole("button", { name: "Publish post now" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await review.getByRole("button", { name: "Fix this" }).click();
    await expect(page.getByLabel("Page address")).toBeFocused();

    await page.getByLabel("Page address").fill("/blog/same-2");
    await expect(page.getByText("This will be /blog/same-2.")).toBeVisible();
    await expect(saveStatus(page)).toHaveText("Saved", { timeout: 5000 });
    await page.getByRole("button", { name: "Publish post" }).click();
    await page.getByRole("button", { name: "Publish post now" }).click();
    await expect(page.getByRole("dialog", { name: "Your post is on your site." })).toBeVisible();
    expect((await page.request.get(`${signedIn.base}/blog/same-2`)).status()).toBe(200);
  });

  test("publishing with no title says so, and leads to the box", async ({ page, signedIn }) => {
    const post = await createEntry(page, signedIn, { title: "" });
    await openPost(page, signedIn, post.id);
    await page.getByRole("button", { name: "Publish post" }).click();
    await expect(page.getByText("This needs a title")).toBeVisible();
    await page.getByRole("button", { name: "Fix this" }).click();
    await expect(page.getByLabel("Title", { exact: true })).toBeFocused();
  });

  test("an address of Tend's own doesn't stop the words being saved", async ({
    page,
    signedIn,
  }) => {
    const entry = await createEntry(page, signedIn, { type: "page", title: "About" });
    await page.goto(`${signedIn.base}/admin/pages/${entry.id}`);
    await openSettings(page);
    await page.getByLabel("Page address").fill("blog");
    await retype(page, "Words worth keeping");
    await expect(page.getByText("Tend uses the address /blog itself.")).toBeVisible({
      timeout: 5000,
    });
    await expect(saveStatus(page)).toHaveText("Saved");
    expect(bodyText(await readEntry(page, signedIn, entry.id))).toBe("Words worth keeping");
  });
});

test.describe("formatting", () => {
  /** Publishes and reads the HTML visitors get. */
  async function publishedHtml(page: Page, site: Site, id: string): Promise<string> {
    await expect(saveStatus(page)).toHaveText("Saved", { timeout: 5000 });
    await page.getByRole("button", { name: /^Publish (post|page)$/ }).click();
    await page.getByRole("button", { name: /^Publish (post|page) now$/ }).click();
    await page.getByRole("button", { name: "Keep editing" }).click();
    const { url } = await readEntry(page, site, id);
    return (await page.request.get(`${site.base}${url}`)).text();
  }

  test("Markdown shortcuts work, and end up as real formatting", async ({ page, signedIn }) => {
    const post = await createEntry(page, signedIn, { title: "Shortcuts", body: "" });
    await openPost(page, signedIn, post.id);
    await body(page).click();
    await page.keyboard.type("## A heading");
    await page.keyboard.press("Enter");
    await page.keyboard.type("### Smaller");
    await page.keyboard.press("Enter");
    await page.keyboard.type("# Top level becomes the biggest allowed");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Some **bold** and *italic* and `code` words");
    await page.keyboard.press("Enter");
    await page.keyboard.type("- one");
    await page.keyboard.press("Enter");
    await page.keyboard.type("two");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.type("1. first");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.type("> Said by someone");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.type("---");
    await page.keyboard.press("Enter");
    await page.keyboard.type("```");
    await page.keyboard.press("Enter");
    await page.keyboard.type("let code = '<x>';");

    const html = await publishedHtml(page, signedIn, post.id);
    expect(html).toContain("<h2>A heading</h2>");
    expect(html).toContain("<h3>Smaller</h3>");
    expect(html).toContain("<h2>Top level becomes the biggest allowed</h2>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain("<ul><li><p>one</p></li><li><p>two</p></li></ul>");
    expect(html).toContain("<ol><li><p>first</p></li></ol>");
    expect(html).toContain("<blockquote><p>Said by someone</p></blockquote>");
    expect(html).toContain("<hr>");
    expect(html).toContain("<pre><code>let code = &#39;&lt;x&gt;&#39;;</code></pre>");
  });

  test('the "/" menu inserts things, and finds them by other names', async ({ page, signedIn }) => {
    const post = await createEntry(page, signedIn, { title: "Slash", body: "" });
    await openPost(page, signedIn, post.id);
    await body(page).click();
    await page.keyboard.type("/");
    const menu = page.getByRole("listbox");
    await expect(menu.getByRole("option", { name: "Heading", exact: true })).toBeVisible();
    await expect(body(page)).toHaveAttribute("aria-activedescendant", /heading2/);

    await page.keyboard.type("dots");
    await expect(menu.getByRole("option")).toHaveText(["Bulleted list"]);
    await page.keyboard.press("Enter");
    await expect(menu).toHaveCount(0);
    await expect(body(page).locator("ul")).toBeVisible();
    await expect(body(page)).not.toContainText("/dots");
    await page.keyboard.type("Item");

    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.type("/nothing like this");
    await expect(page.getByRole("listbox")).toHaveCount(0);
  });

  test('Escape closes the "/" menu and leaves the slash as written', async ({ page, signedIn }) => {
    const post = await createEntry(page, signedIn, { title: "Slash", body: "" });
    await openPost(page, signedIn, post.id);
    await body(page).click();
    await page.keyboard.type("either/or and /");
    await expect(page.getByRole("listbox")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("listbox")).toHaveCount(0);
    await expect(body(page)).toHaveText("either/or and /");
  });

  test("the Insert button offers the same things, by keyboard too", async ({ page, signedIn }) => {
    const post = await createEntry(page, signedIn, { title: "Insert", body: "" });
    await openPost(page, signedIn, post.id);
    const insert = page.getByRole("button", { name: "Insert +" });
    await insert.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("menuitem", { name: "Heading", exact: true })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("menuitem", { name: "Subheading" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(insert).toBeFocused();
    await expect(page.getByRole("menu")).toHaveCount(0);

    await insert.click();
    await page.getByRole("menuitem", { name: "Quote" }).click();
    await expect(body(page).locator("blockquote")).toBeVisible();
    await expect(body(page)).toBeFocused();
  });

  test("Undo and Redo buttons work, for people without a keyboard", async ({ page, signedIn }) => {
    const post = await createEntry(page, signedIn, { title: "Undo", body: "" });
    await openPost(page, signedIn, post.id);
    await expect(page.getByRole("button", { name: "Undo" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await body(page).click();
    await page.keyboard.type("Words");
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(body(page)).toHaveText("");
    await page.getByRole("button", { name: "Redo" }).click();
    await expect(body(page)).toHaveText("Words");
  });

  test("the toolbar shows and changes formatting", async ({ page, signedIn }) => {
    const post = await createEntry(page, signedIn, { title: "Bold", body: "Some words" });
    await openPost(page, signedIn, post.id);
    await body(page).click();
    await page.keyboard.press("ControlOrMeta+a");
    const bold = page.getByRole("button", { name: "Bold" }).first();
    await bold.click();
    await expect(bold).toHaveAttribute("aria-pressed", "true");
    await expect(body(page).locator("strong")).toHaveText("Some words");
    await expect(body(page)).toBeFocused();
  });

  test("selected words get a toolbar of their own on a computer", async ({ page, signedIn }) => {
    const post = await createEntry(page, signedIn, { title: "Bubble", body: "Some words" });
    await openPost(page, signedIn, post.id);
    await body(page).click();
    await page.keyboard.press("ControlOrMeta+a");
    const underline = page.getByRole("button", { name: "Underline" });
    await expect(underline).toBeVisible();
    await underline.click();
    await expect(body(page).locator("u")).toHaveText("Some words");
  });

  test("Ctrl+K links to another page by searching for it, and it follows moves", async ({
    page,
    signedIn,
  }) => {
    const about = await createEntry(page, signedIn, {
      type: "page",
      title: "All about us",
      publish: true,
    });
    const post = await createEntry(page, signedIn, { title: "Linker", body: "Read this" });
    await openPost(page, signedIn, post.id);
    await body(page).click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("ControlOrMeta+k");

    const dialog = page.getByRole("dialog", { name: "Add a link" });
    const search = dialog.getByLabel("Search your pages, or paste an address");
    await expect(search).toBeFocused();
    await search.fill("about");
    await dialog.getByRole("button", { name: /All about us/ }).click();
    await expect(dialog.getByText('Goes to "All about us"')).toBeVisible();
    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(body(page)).toBeFocused();
    await expect(body(page).locator("a")).toHaveText("Read this");

    const html = await publishedHtml(page, signedIn, post.id);
    expect(html).toContain(`<a href="${about.url}">Read this</a>`);

    await page.request.patch(`${signedIn.base}/api/admin/entries/${about.id}`, {
      headers: { "If-Match": String(about.rev) },
      data: { slug: "moved" },
    });
    await page.request.post(`${signedIn.base}/api/admin/entries/${about.id}/publish`, {
      headers: { "If-Match": String(about.rev + 1) },
      data: {},
    });
    const later = await (await page.request.get(`${signedIn.base}/blog/linker`)).text();
    expect(later).toContain('<a href="/moved">Read this</a>');
  });

  test("a link dialog understands what people paste, and refuses what's unsafe", async ({
    page,
    signedIn,
  }) => {
    const post = await createEntry(page, signedIn, { title: "Links", body: "Words" });
    await openPost(page, signedIn, post.id);
    await body(page).click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("ControlOrMeta+k");
    const dialog = page.getByRole("dialog", { name: "Add a link" });
    const search = dialog.getByLabel("Search your pages, or paste an address");

    await search.fill("javascript:alert(1)");
    await search.press("Enter");
    await expect(dialog.getByText("That doesn't look like an address.")).toBeVisible();

    await search.fill("example.com/menu");
    await search.press("Enter");
    await expect(dialog).toHaveCount(0);
    await expect(body(page).locator("a")).toHaveAttribute("href", "https://example.com/menu");
    await expect(body(page)).toBeFocused();

    await page.keyboard.press("ControlOrMeta+k");
    await expect(dialog.getByLabel("Search your pages, or paste an address")).toHaveValue(
      "https://example.com/menu",
    );
    await dialog.getByRole("button", { name: "Remove link" }).click();
    await expect(body(page).locator("a")).toHaveCount(0);
  });

  test("a button can be added, edited and goes where it says", async ({ page, signedIn }) => {
    const post = await createEntry(page, signedIn, { title: "Buttons", body: "" });
    await openPost(page, signedIn, post.id);
    await body(page).click();
    await page.keyboard.type("/button");
    await page.keyboard.press("Enter");

    const dialog = page.getByRole("dialog", { name: "Button" });
    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(dialog.getByText("Type some words for the button.")).toBeVisible();
    await dialog.getByLabel("Words on the button").fill("Order bread");
    await dialog.getByLabel("Search your pages, or paste an address").fill("https://example.com/");
    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(page.getByText("Order bread").first()).toBeVisible();

    await page.getByRole("button", { name: 'Edit "Order bread" button' }).click();
    await dialog.getByLabel("Words on the button").fill("Order now");
    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(page.getByText("Order now").first()).toBeVisible();

    const html = await publishedHtml(page, signedIn, post.id);
    expect(html).toContain('<a class="t-button" href="https://example.com/">Order now</a>');
  });

  test("a page can have a big intro, and a post can't", async ({ page, signedIn }) => {
    const entry = await createEntry(page, signedIn, { type: "page", title: "Welcome", body: "" });
    await page.goto(`${signedIn.base}/admin/pages/${entry.id}`);
    await body(page).click();
    await page.keyboard.type("/hero");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Fresh bread");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Every morning");
    await page.getByLabel("Background").selectOption("muted");
    await page.getByLabel("Alignment").selectOption("center");

    const html = await publishedHtml(page, signedIn, entry.id);
    expect(html).toContain('class="t-intro t-tone-muted t-align-center"');
    expect(html).toContain("<h2>Fresh bread</h2>");

    const post = await createEntry(page, signedIn, { title: "Post", body: "" });
    await openPost(page, signedIn, post.id);
    await page.getByRole("button", { name: "Insert +" }).click();
    await expect(page.getByRole("menuitem", { name: "Big intro" })).toHaveCount(0);
  });

  test("everything comes back exactly as saved, with nothing to save", async ({
    page,
    signedIn,
  }) => {
    const post = await createEntry(page, signedIn, { title: "Round trip", body: "" });
    await openPost(page, signedIn, post.id);
    await body(page).click();
    for (const line of ["## Heading", "A **bold** line", "- item"]) {
      await page.keyboard.type(line);
      await page.keyboard.press("Enter");
    }
    await page.keyboard.press("Enter");
    await page.keyboard.type("---");
    await page.keyboard.press("Enter");
    await page.keyboard.type("/button");
    await page.keyboard.press("Enter");
    await page.getByLabel("Words on the button").fill("Go");
    await page.getByRole("button", { name: "Done" }).click();
    await expect(saveStatus(page)).toHaveText("Saved", { timeout: 5000 });

    let saves = 0;
    page.on("request", (request) => {
      if (request.method() === "PATCH") saves++;
    });
    await page.reload();
    await expect(body(page).locator("h2")).toHaveText("Heading");
    await body(page).click();
    await page.waitForTimeout(2500);
    await expect(saveStatus(page)).toHaveText("Saved");
    expect(saves).toBe(0);
    await expect(page.getByText("hadn't reached the server")).toHaveCount(0);
  });

  test("pasting from a document keeps the formatting, and says what it couldn't keep", async ({
    page,
    signedIn,
  }) => {
    const post = await createEntry(page, signedIn, { title: "Pasted", body: "" });
    await openPost(page, signedIn, post.id);
    await body(page).click();
    await page.evaluate(() => {
      const data = new DataTransfer();
      data.setData(
        "text/html",
        `<meta charset="utf-8"><b style="font-weight:normal" id="docs-internal-guid-1">
          <h1>From a doc</h1>
          <p><span style="font-weight:700">Heavy</span> and light</p>
          <h5>Tiny heading</h5>
          <table><tr><td>Cell one</td><td>Cell two</td></tr></table>
          <p><a href="javascript:alert(1)">Bad link</a></p>
          <script>window.pwned = true</script>
          <img src="https://example.com/x.png" onerror="window.pwned = true">
        </b>`,
      );
      document
        .querySelector('[role="textbox"][contenteditable]')
        ?.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true }));
    });
    await expect(body(page).locator("h2")).toHaveText("From a doc");
    await expect(body(page).locator("h4")).toHaveText("Tiny heading");
    await expect(body(page).locator("strong")).toHaveText("Heavy");
    await expect(body(page)).toContainText("Cell one");
    await expect(body(page).locator("a")).toHaveCount(0);
    await expect(body(page).locator("img")).toHaveCount(0);
    expect(await page.evaluate(() => "pwned" in window)).toBe(false);
    await expect(page.getByText("Pictures from another website were left out")).toBeVisible();
    await expect(saveStatus(page)).toHaveText("Saved", { timeout: 5000 });
  });

  test("a table's own notice shows when only a table is pasted", async ({ page, signedIn }) => {
    const post = await createEntry(page, signedIn, { title: "Pasted", body: "" });
    await openPost(page, signedIn, post.id);
    await body(page).click();
    await page.evaluate(() => {
      const data = new DataTransfer();
      data.setData("text/html", "<table><tr><td>Cell one</td></tr></table>");
      document
        .querySelector('[role="textbox"][contenteditable]')
        ?.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true }));
    });
    await expect(page.getByText("A table was turned into text")).toBeVisible();
    await expect(body(page)).toContainText("Cell one");
  });
});

test.describe("saving as you type", () => {
  test("saves by itself soon after typing stops", async ({ page, signedIn }) => {
    const post = await createEntry(page, signedIn, { title: "Draft", body: "" });
    await openPost(page, signedIn, post.id);
    await body(page).click();
    await page.keyboard.type("Without pressing anything");
    await expect(saveStatus(page)).toHaveText("Saving…");
    await expect(saveStatus(page)).toHaveText("Saved", { timeout: 4000 });
    expect(bodyText(await readEntry(page, signedIn, post.id))).toBe("Without pressing anything");
  });

  test("saves at least every ten seconds, even if typing never stops", async ({
    page,
    signedIn,
  }) => {
    const post = await createEntry(page, signedIn, { title: "Draft", body: "" });
    await openPost(page, signedIn, post.id);
    await body(page).click();
    const saved = page.waitForResponse((response) => response.request().method() === "PATCH", {
      timeout: 12_000,
    });
    let keepTyping = true;
    void saved.finally(() => {
      keepTyping = false;
    });
    while (keepTyping) await page.keyboard.type("a", { delay: 200 });
    expect((await saved).status()).toBe(200);
  });

  test("a trailing space isn't taken away while someone's still typing", async ({
    page,
    signedIn,
  }) => {
    const post = await createEntry(page, signedIn, { title: "", body: "" });
    await openPost(page, signedIn, post.id);
    await page.getByLabel("Title", { exact: true }).click();
    await page.keyboard.type("Fresh ");
    await expect(saveStatus(page)).toHaveText("Saved", { timeout: 5000 });
    await page.keyboard.type("bread");
    await expect(page.getByLabel("Title", { exact: true })).toHaveValue("Fresh bread");
  });

  test("Ctrl+S saves straight away", async ({ page, signedIn }) => {
    const post = await createEntry(page, signedIn, { title: "Draft", body: "" });
    await openPost(page, signedIn, post.id);
    await body(page).click();
    await page.keyboard.type("Now");
    const saved = page.waitForResponse((response) => response.request().method() === "PATCH");
    await page.keyboard.press("ControlOrMeta+s");
    await saved;
    await expect(saveStatus(page)).toHaveText("Saved");
  });

  test("when offline it says so, keeps the words, and catches up by itself", async ({
    page,
    signedIn,
  }) => {
    const post = await createEntry(page, signedIn, { title: "Draft", body: "" });
    await openPost(page, signedIn, post.id);
    await failSaves(page);
    await body(page).click();
    await page.keyboard.type("Typed on a train");
    await expect(saveStatus(page)).toContainText("Offline. Changes kept on this device", {
      timeout: 5000,
    });
    await expect(body(page)).toHaveText("Typed on a train");

    await page.unroute(SAVE_PATH);
    await expect(saveStatus(page)).toHaveText("Saved", { timeout: 10_000 });
    expect(bodyText(await readEntry(page, signedIn, post.id))).toBe("Typed on a train");
  });

  test("coming back online saves without waiting", async ({ page, signedIn }) => {
    const post = await createEntry(page, signedIn, { title: "Draft", body: "" });
    await openPost(page, signedIn, post.id);
    await failSaves(page);
    await body(page).click();
    await page.keyboard.type("Back online");
    await expect(saveStatus(page)).toContainText("Offline", { timeout: 5000 });
    await page.unroute(SAVE_PATH);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect(saveStatus(page)).toHaveText("Saved", { timeout: 1500 });
  });

  test("if the server has a problem, it says so and tries again", async ({ page, signedIn }) => {
    const post = await createEntry(page, signedIn, { title: "Draft", body: "" });
    await openPost(page, signedIn, post.id);
    await page.route(SAVE_PATH, (route) =>
      isSave(route)
        ? route.fulfill({
            status: 500,
            contentType: "application/json",
            body: JSON.stringify({
              error: { code: "internal", message: "Something went wrong on Tend's side." },
            }),
          })
        : route.fallback(),
    );
    await body(page).click();
    await page.keyboard.type("Words");
    await expect(page.getByText("Something went wrong on Tend's side.")).toBeVisible({
      timeout: 5000,
    });
    await expect(saveStatus(page)).toHaveText("Not saved yet");
    await page.unroute(SAVE_PATH);
    await expect(saveStatus(page)).toHaveText("Saved", { timeout: 10_000 });
    await expect(page.getByText("Something went wrong on Tend's side.")).toHaveCount(0);
  });

  test("after a save is refused, the next change saves by itself", async ({ page, signedIn }) => {
    const post = await createEntry(page, signedIn, { title: "Draft", body: "" });
    await openPost(page, signedIn, post.id);
    let refused = 0;
    await page.route(SAVE_PATH, (route) => {
      if (!isSave(route) || refused > 0) return route.fallback();
      refused += 1;
      return route.fulfill({
        status: 413,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "too_large",
            message: "That's more than Tend can save in one go.",
            fix: "Split it into two.",
          },
        }),
      });
    });
    await retype(page, "Far too long");
    await expect(page.getByText("more than Tend can save").first()).toBeVisible({ timeout: 5000 });
    await expect(saveStatus(page)).toHaveText("Not saved yet");

    // Cutting it down is the fix. Nobody should have to know to press Ctrl+S after that.
    await body(page).click();
    await page.keyboard.press("End");
    await page.keyboard.type(", cut down");
    await expect(saveStatus(page)).toHaveText("Saved", { timeout: 5000 });
    expect(bodyText(await readEntry(page, signedIn, post.id))).toBe("Far too long, cut down");
    expect(refused).toBe(1);
  });
});

test.describe("never losing what's typed", () => {
  test("a crash, with the server killed and the tab closed, loses nothing", async ({
    page,
    signedIn,
    context,
  }) => {
    const post = await createEntry(page, signedIn, { title: "Draft", body: "Saved earlier" });
    await openPost(page, signedIn, post.id);
    await signedIn.crash();
    await retype(page, "Written just before the crash");
    // PLAN.md P5: everything typed up to 2 seconds before.
    await page.waitForTimeout(2000);
    await page.close();

    await signedIn.restart();
    const again = await context.newPage();
    await again.goto(`${signedIn.base}/admin/posts/${post.id}`);
    await expect(body(again)).toHaveText("Written just before the crash");
    await expect(again.getByText("hadn't reached the server")).toBeVisible();
    // Not saved over the server's copy until someone's seen it and carried on.
    expect(bodyText(await readEntry(again, signedIn, post.id))).toBe("Saved earlier");

    await again.getByRole("button", { name: "Keep these changes" }).click();
    await expect(saveStatus(again)).toHaveText("Saved", { timeout: 5000 });
    expect(bodyText(await readEntry(again, signedIn, post.id))).toBe(
      "Written just before the crash",
    );
    await expect(again.getByText("hadn't reached the server")).toHaveCount(0);
  });

  test("closing the tab straight after typing keeps it", async ({ page, signedIn, context }) => {
    const post = await createEntry(page, signedIn, { title: "Draft", body: "Saved earlier" });
    await openPost(page, signedIn, post.id);
    // Down before typing, so the tab can close straight after. Its last save can't be failed
    // from the browser (see closeWhileDown), and getting through would hide a lost copy.
    await signedIn.crash();
    await retype(page, "Typed then closed");
    await page.close({ runBeforeUnload: true });
    await signedIn.restart();

    const again = await context.newPage();
    // The server never got them, so what comes back is the copy kept on this device.
    expect(bodyText(await readEntry(again, signedIn, post.id))).toBe("Saved earlier");
    await again.goto(`${signedIn.base}/admin/posts/${post.id}`);
    await expect(body(again)).toHaveText("Typed then closed");
    await expect(again.getByText("hadn't reached the server")).toBeVisible();
  });

  test("typing while a save is running isn't overwritten by its answer", async ({
    page,
    signedIn,
  }) => {
    const post = await createEntry(page, signedIn, { title: "Draft", body: "" });
    await openPost(page, signedIn, post.id);
    await slowSaves(page, 800);

    await body(page).click();
    await page.keyboard.type("First part");
    const answered = page.waitForResponse((response) => response.request().method() === "PATCH");
    await page.keyboard.press("ControlOrMeta+s");
    await page.keyboard.type(" and more", { delay: 10 });
    await answered;

    await expect(body(page)).toHaveText("First part and more");
    await expect(saveStatus(page)).toHaveText("Saved", { timeout: 5000 });
    expect(bodyText(await readEntry(page, signedIn, post.id))).toBe("First part and more");
  });

  test("typing during a publish isn't overwritten either", async ({ page, signedIn }) => {
    const post = await createEntry(page, signedIn, { title: "Draft", body: "Live words" });
    await openPost(page, signedIn, post.id);
    await page.getByRole("button", { name: "Publish post" }).click();
    await page.route("**/publish", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      await route.fallback();
    });
    await page.getByRole("button", { name: "Publish post now" }).click();
    await page.getByRole("dialog", { name: "Your post is on your site." }).waitFor();
    await page.getByRole("button", { name: "Keep editing" }).click();
    await body(page).click();
    await page.keyboard.press("End");
    await page.keyboard.type(" fixed a typo");
    await expect(saveStatus(page)).toContainText("not on your site yet", { timeout: 5000 });
    await expect(body(page)).toHaveText("Live words fixed a typo");
  });

  test("leaving the editor saves what's typed", async ({ page, signedIn }) => {
    const post = await createEntry(page, signedIn, { title: "Draft" });
    await openPost(page, signedIn, post.id);
    await retype(page, "Typed then left");
    await postsLink(page).click();
    await expect(page.getByRole("heading", { name: "Posts" })).toBeVisible();
    await expect
      .poll(async () => bodyText(await readEntry(page, signedIn, post.id)))
      .toBe("Typed then left");
    await expect(page.getByText("haven't reached")).toHaveCount(0);
  });

  test("if that save fails, the text is kept and the admin says where it is", async ({
    page,
    signedIn,
  }) => {
    const post = await createEntry(page, signedIn, { title: "Draft" });
    await openPost(page, signedIn, post.id);
    await failSaves(page);
    await retype(page, "A long paragraph typed on the bus");
    await postsLink(page).click();

    await expect(page.getByText('Your changes to "Draft" haven\'t reached')).toBeVisible();
    await page.unroute(SAVE_PATH);

    await page.getByRole("link", { name: "Open them" }).click();
    await expect(body(page)).toHaveText("A long paragraph typed on the bus");
    await expect(page.getByText("hadn't reached the server")).toBeVisible();

    await page.getByRole("button", { name: "Keep these changes" }).click();
    await expect(saveStatus(page)).toHaveText("Saved", { timeout: 5000 });
    expect(bodyText(await readEntry(page, signedIn, post.id))).toBe(
      "A long paragraph typed on the bus",
    );

    await postsLink(page).click();
    await expect(page.getByText("haven't reached")).toHaveCount(0);
  });

  test("a held draft can be thrown away on purpose", async ({ page, signedIn }) => {
    const post = await createEntry(page, signedIn, { title: "Draft", body: "On the server" });
    await openPost(page, signedIn, post.id);
    await failSaves(page);
    await retype(page, "Second thoughts");
    await postsLink(page).click();
    await page.getByRole("link", { name: "Open them" }).click();
    await page.getByRole("button", { name: "Go back to the saved version" }).click();
    await expect(body(page)).toHaveText("On the server");
    await expect(saveStatus(page)).toHaveText("Saved");
    await postsLink(page).click();
    await expect(page.getByText("haven't reached")).toHaveCount(0);
  });

  test("someone else signing in on this computer neither sees it nor disturbs it", async ({
    page,
    signedIn,
    context,
  }) => {
    const post = await createEntry(page, signedIn, { title: "Draft", body: "On the server" });
    await openPost(page, signedIn, post.id);
    await failSaves(page);
    await retype(page, "Private words");
    await expect(saveStatus(page)).toContainText("Offline", { timeout: 5000 });
    expect(await heldRows(page)).toHaveLength(1);

    await closeWhileDown(signedIn, page);

    // The same entry, with this copy belonging to someone else on this device.
    const again = await context.newPage();
    await again.goto(`${signedIn.base}/admin/`);
    await again.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve) => {
        const open = indexedDB.open("tend");
        open.onsuccess = () => resolve(open.result);
      });
      await new Promise((resolve) => {
        const store = db.transaction("drafts", "readwrite").objectStore("drafts");
        const get = store.getAll();
        get.onsuccess = () => {
          const row = get.result[0];
          store.delete(row.key);
          store.put({
            ...row,
            key: "someone-elses",
            editSession: "someone-elses",
            userId: "someone-else",
          }).onsuccess = resolve;
        };
      });
    });
    await again.goto(`${signedIn.base}/admin/posts/${post.id}`);
    await expect(body(again)).toHaveText("On the server");
    await expect(again.getByText("hadn't reached the server")).toHaveCount(0);

    await body(again).click();
    await again.keyboard.press("End");
    await again.keyboard.type(", and more");
    await expect(saveStatus(again)).toHaveText("Saved", { timeout: 5000 });
    const rows = await heldRows(again);
    expect(rows.map((row) => row.userId)).toContain("someone-else");
  });

  test("updating Tend keeps what an older admin left on this device", async ({
    page,
    signedIn,
    context,
  }) => {
    const post = await createEntry(page, signedIn, { title: "Draft", body: "On the server" });
    await openPost(page, signedIn, post.id);
    await failSaves(page);
    await retype(page, "Typed before the update");
    await expect(saveStatus(page)).toContainText("Offline", { timeout: 5000 });
    await closeWhileDown(signedIn, page);

    // The same copy, in a store of the first version, as an older admin would have left it.
    // Opening the editor then updates the store, and the copy has to survive that.
    const again = await context.newPage();
    await again.goto(`${signedIn.base}/healthz`);
    const moved = await again.evaluate(async () => {
      const open = (version?: number, upgrade?: (db: IDBDatabase) => void) =>
        new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open("tend", version);
          request.onupgradeneeded = () => upgrade?.(request.result);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
      const current = await open();
      const rows = await new Promise<unknown[]>((resolve) => {
        const get = current.transaction("drafts").objectStore("drafts").getAll();
        get.onsuccess = () => resolve(get.result);
      });
      current.close();
      await new Promise((resolve) => {
        indexedDB.deleteDatabase("tend").onsuccess = resolve;
      });
      const older = await open(1, (db) => {
        const store = db.createObjectStore("drafts", { keyPath: "key" });
        for (const row of rows) store.put(row);
      });
      older.close();
      return rows.length;
    });
    expect(moved).toBe(1);

    await again.goto(`${signedIn.base}/admin/posts/${post.id}`);
    await expect(body(again)).toHaveText("Typed before the update");
    await expect(again.getByText("hadn't reached the server")).toBeVisible();
  });

  test("an open editor doesn't stop a newer admin updating what's on this device", async ({
    page,
    signedIn,
    context,
  }) => {
    const post = await createEntry(page, signedIn, { title: "Draft", body: "On the server" });
    await openPost(page, signedIn, post.id);
    await failSaves(page);
    await retype(page, "Typed in the older tab");
    await expect(saveStatus(page)).toContainText("kept on this device", { timeout: 5000 });

    const newer = await context.newPage();
    await newer.goto(`${signedIn.base}/healthz`);
    const outcome = await newer.evaluate(
      () =>
        new Promise<string>((resolve) => {
          const request = indexedDB.open("tend", 99);
          request.onblocked = () => resolve("blocked");
          request.onerror = () => resolve("failed");
          request.onsuccess = () => {
            request.result.close();
            resolve("updated");
          };
        }),
    );
    expect(outcome).toBe("updated");

    // The older tab can't use a store newer than it knows, so it stops saying its words are
    // kept there.
    await retype(page, "Typed after the update");
    await expect(saveStatus(page)).toContainText("only in this window", { timeout: 5000 });
  });

  test("a network blip doesn't replace the open editor", async ({ page, signedIn }) => {
    const post = await createEntry(page, signedIn, { title: "Draft" });
    await openPost(page, signedIn, post.id);
    await retype(page, "Mid-sentence");
    await page.route(SAVE_PATH, (route) => route.abort());
    await page.evaluate(() => {
      window.dispatchEvent(new Event("offline"));
      window.dispatchEvent(new Event("online"));
      window.dispatchEvent(new Event("focus"));
    });
    await page.waitForTimeout(400);
    await expect(body(page)).toHaveText("Mid-sentence");
    await expect(page.getByRole("heading", { name: "Can't reach Tend" })).toHaveCount(0);
  });

  test("reloading straight after typing brings it back", async ({ page, signedIn }) => {
    const post = await createEntry(page, signedIn, { title: "Draft", body: "Saved words" });
    await openPost(page, signedIn, post.id);
    await failSaves(page);
    await retype(page, "Unsaved words");
    await page.waitForTimeout(400);
    await page.reload();
    await expect(body(page)).toHaveText("Unsaved words");
    // The page tries to save as it goes. Either that worked or it's offered back, never neither.
    if (bodyText(await readEntry(page, signedIn, post.id)) !== "Unsaved words") {
      await expect(page.getByText("hadn't reached the server")).toBeVisible();
    }
  });

  test("signing out saves first, and doesn't go ahead if it can't", async ({ page, signedIn }) => {
    const post = await createEntry(page, signedIn, { title: "Draft" });
    await openPost(page, signedIn, post.id);
    await failSaves(page);
    await retype(page, "Don't lose this");
    await page.getByRole("button", { name: "Sign out" }).click();

    await expect(page.getByText("Can't reach Tend").first()).toBeVisible();
    await expect(body(page)).toHaveText("Don't lose this");
    await expect(page).toHaveURL(/\/admin\/posts\//);

    await page.unroute(SAVE_PATH);
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();

    await signIn(page, signedIn);
    expect(bodyText(await readEntry(page, signedIn, post.id))).toBe("Don't lose this");
  });

  test("a session ending mid-edit keeps the text for after signing in again", async ({
    page,
    signedIn,
  }) => {
    const post = await createEntry(page, signedIn, { title: "Draft" });
    await openPost(page, signedIn, post.id);
    await page.context().clearCookies({ name: "tend_session" });
    await retype(page, "Written before the session ended");

    await expect(saveStatus(page)).toContainText("You've been signed out", { timeout: 5000 });
    await expect(body(page)).toHaveText("Written before the session ended");

    await postsLink(page).click();
    await signIn(page, signedIn);
    await expect(page.getByText('Your changes to "Draft" haven\'t reached')).toBeVisible();
    await page.getByRole("link", { name: "Open them" }).click();
    await expect(body(page)).toHaveText("Written before the session ended");
  });

  test("reopening straight after leaving shows the new text, not an old copy", async ({
    page,
    signedIn,
  }) => {
    const post = await createEntry(page, signedIn, { title: "Quick return", body: "Old text" });
    await openPost(page, signedIn, post.id);
    await slowSaves(page, 600);
    await retype(page, "New text");
    await postsLink(page).click();
    await page.getByRole("link", { name: "Quick return" }).click();

    await expect(body(page)).toHaveText("New text");
    // It really is saved, so there's nothing to warn about.
    await expect(saveStatus(page)).toHaveText("Saved");
    await expect(page.getByText("hadn't reached the server")).toHaveCount(0);
  });

  test("going Back during a publish lets it finish", async ({ page, signedIn }) => {
    const post = await createEntry(page, signedIn, { title: "Hurried" });
    await openPost(page, signedIn, post.id);
    await page.route("**/publish", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      await route.fallback();
    });
    await retype(page, "Final words");
    await page.getByRole("button", { name: "Publish post" }).click();
    await page.getByRole("button", { name: "Publish post now" }).click();
    await page.keyboard.press("Escape");
    await page.getByRole("link", { name: "Back to posts" }).click();

    await expect
      .poll(async () => {
        const entry = await readEntry(page, signedIn, post.id);
        return { url: entry.url, text: bodyText(entry) };
      })
      .toEqual({ url: "/blog/hurried", text: "Final words" });
  });

  test("going Back during a save still saves what was typed after it", async ({
    page,
    signedIn,
  }) => {
    const post = await createEntry(page, signedIn, { title: "Draft" });
    await openPost(page, signedIn, post.id);
    await slowSaves(page, 400);
    await retype(page, "Part one");
    await page.keyboard.press("ControlOrMeta+s");
    await page.keyboard.type(" and part two", { delay: 5 });
    await page.getByRole("link", { name: "Back to posts" }).click();

    await expect
      .poll(async () => bodyText(await readEntry(page, signedIn, post.id)))
      .toBe("Part one and part two");
    await expect(page.getByText("haven't reached")).toHaveCount(0);
  });

  test("an answer lost on the way back doesn't cause a false conflict", async ({
    page,
    signedIn,
  }) => {
    const post = await createEntry(page, signedIn, { title: "Draft" });
    await openPost(page, signedIn, post.id);
    let first = true;
    await page.route(SAVE_PATH, async (route) => {
      if (isSave(route) && first) {
        first = false;
        await route.fetch();
        await route.abort();
        return;
      }
      await route.fallback();
    });
    await retype(page, "Saved but unheard");
    await expect(saveStatus(page)).toContainText("Offline", { timeout: 5000 });
    // More typing before it's caught up, so this isn't just the same words again.
    await page.keyboard.type(" and then some");
    await expect(saveStatus(page)).toHaveText("Saved", { timeout: 10_000 });
    await expect(page.getByText("changed this")).toHaveCount(0);
    expect(bodyText(await readEntry(page, signedIn, post.id))).toBe(
      "Saved but unheard and then some",
    );
  });
});

test.describe("two people editing", () => {
  async function conflictOnScreen(page: Page, site: Site) {
    const post = await createEntry(page, site, { title: "Original", body: "Original text" });
    await openPost(page, site, post.id);
    await page.request.patch(`${site.base}/api/admin/entries/${post.id}`, {
      headers: { "If-Match": String(post.rev) },
      data: { title: "Their title" },
    });
    await retype(page, "My text");
    await expect(page.getByText("You changed this on another device.")).toBeVisible({
      timeout: 5000,
    });
    return post;
  }

  test("shows the other version, and holds the fields still while choosing", async ({
    page,
    signedIn,
  }) => {
    await conflictOnScreen(page, signedIn);
    await expect(page.getByText("Their title")).toBeVisible();
    await expect(body(page)).not.toBeEditable();
    await expect(body(page)).toHaveText("My text");
  });

  test("Use this one carries on with what I typed, and keeps theirs in History", async ({
    page,
    signedIn,
  }) => {
    const post = await conflictOnScreen(page, signedIn);
    await page.getByRole("button", { name: "Use this one" }).click();
    await expect(page.getByText("changed this")).toHaveCount(0);
    await expect(body(page)).toHaveText("My text");
    await expect(body(page)).toBeEditable();
    expect(bodyText(await readEntry(page, signedIn, post.id))).toBe("My text");

    await page.getByRole("button", { name: "History" }).click();
    await expect(page.getByText("Another version, kept for you").first()).toBeVisible();
  });

  test("Use the newest version carries on with theirs, and keeps mine in History", async ({
    page,
    signedIn,
  }) => {
    await conflictOnScreen(page, signedIn);
    await page.getByRole("button", { name: "Use the newest version" }).click();
    await expect(page.getByLabel("Title", { exact: true })).toHaveValue("Their title");
    await expect(body(page)).toHaveText("Original text");
    await expect(saveStatus(page)).toHaveText("Saved");
    await expect(page.getByText("hadn't reached the server")).toHaveCount(0);

    await page.getByRole("button", { name: "History" }).click();
    await expect(page.getByText("Another version, kept for you").first()).toBeVisible();
  });
});

test.describe("reviewing before publishing", () => {
  test("gently points out things worth another look, without stopping anything", async ({
    page,
    signedIn,
  }) => {
    const draft = await createEntry(page, signedIn, { type: "page", title: "Not ready yet" });
    const post = await createEntry(page, signedIn, { title: "Checked", body: "" });
    await page.request.patch(`${signedIn.base}/api/admin/entries/${post.id}`, {
      headers: { "If-Match": String(post.rev) },
      data: {
        doc: {
          type: "doc",
          content: [
            { type: "heading", attrs: { level: 4 }, content: [{ type: "text", text: "Skipped" }] },
            {
              type: "paragraph",
              content: [
                {
                  type: "text",
                  text: "click here",
                  marks: [{ type: "link", attrs: { href: "https://example.com" } }],
                },
                { type: "text", text: " or " },
                {
                  type: "text",
                  text: "this",
                  marks: [{ type: "link", attrs: { href: `entry:${draft.id}` } }],
                },
              ],
            },
            { type: "button", attrs: { href: "", label: "Nowhere" } },
          ],
        },
      },
    });
    await openPost(page, signedIn, post.id);
    await page.getByRole("button", { name: "Publish post" }).click();
    const review = page.getByRole("dialog", { name: "Ready to publish?" });
    await expect(review.getByText("A heading skips a level")).toBeVisible();
    await expect(review.getByText('A link just says "click here"')).toBeVisible();
    await expect(review.getByText('"Not ready yet" isn\'t on your site')).toBeVisible();
    await expect(review.getByText('The "Nowhere" button doesn\'t go anywhere')).toBeVisible();

    await review.getByRole("button", { name: "Publish post now" }).click();
    await expect(page.getByRole("dialog", { name: "Your post is on your site." })).toBeVisible();
  });

  test("an empty post gets a mention", async ({ page, signedIn }) => {
    const post = await createEntry(page, signedIn, { title: "Empty", body: "" });
    await openPost(page, signedIn, post.id);
    await page.getByRole("button", { name: "Publish post" }).click();
    await expect(page.getByText("This has no words yet.")).toBeVisible();
    await page.getByRole("button", { name: "Not yet" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(saveStatus(page)).toHaveText("Saved");
  });

  test("moving something on the site is pointed out before it happens", async ({
    page,
    signedIn,
  }) => {
    const post = await createEntry(page, signedIn, { title: "Moving", publish: true });
    await openPost(page, signedIn, post.id);
    await openSettings(page);
    await page.getByLabel("Page address").fill("moved");
    await expect(saveStatus(page)).toContainText("not on your site yet", { timeout: 5000 });
    await page.getByRole("button", { name: "Publish changes" }).click();
    await expect(page.getByText("This moves it from /blog/moving to /blog/moved.")).toBeVisible();
  });

  test("a failed publish is shown in the review, where someone's looking", async ({
    page,
    signedIn,
  }) => {
    const post = await createEntry(page, signedIn, { title: "Draft" });
    await openPost(page, signedIn, post.id);
    await page.getByRole("button", { name: "Publish post" }).click();
    await page.route("**/publish", (route) => route.abort());
    await page.getByRole("button", { name: "Publish post now" }).click();
    await expect(page.getByRole("dialog").getByText("Can't reach Tend")).toBeVisible();
    await page.unroute("**/publish");
    await page.getByRole("button", { name: "Publish post now" }).click();
    await expect(page.getByRole("dialog", { name: "Your post is on your site." })).toBeVisible();
  });
});

test.describe("preview", () => {
  test("shows unsaved words in the real design, safely sandboxed", async ({ page, signedIn }) => {
    const post = await createEntry(page, signedIn, { title: "Preview me", body: "" });
    await openPost(page, signedIn, post.id);
    await retype(page, "Not saved yet <img src=x onerror=window.top.pwned=1>");
    await page.getByRole("button", { name: "Preview" }).click();

    const dialog = page.getByRole("dialog", { name: "Preview" });
    const frame = page.frameLocator("iframe");
    await expect(frame.getByRole("heading", { name: "Preview me" })).toBeVisible();
    await expect(frame.getByText("Not saved yet")).toBeVisible();
    await expect(dialog.locator("iframe")).toHaveAttribute("sandbox", "");
    // The theme's own stylesheet really applied, inside the sandbox.
    await expect(frame.locator("body")).toHaveCSS("line-height", /\d/);
    const size = await frame
      .locator("body")
      .evaluate((element) => getComputedStyle(element).fontSize);
    expect(size).toBe("18px");
    expect(await page.evaluate(() => "pwned" in window)).toBe(false);

    await dialog.getByRole("button", { name: "Phone" }).click();
    await expect(dialog.locator("iframe")).toHaveCSS("max-width", "375px");
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(page.getByRole("button", { name: "Preview" })).toBeFocused();
  });

  test("clicking a link inside stays in the preview", async ({ page, signedIn }) => {
    const post = await createEntry(page, signedIn, { title: "Links", body: "Words" });
    await openPost(page, signedIn, post.id);
    await page.getByRole("button", { name: "Preview" }).click();
    const frame = page.frameLocator("iframe");
    await frame.getByRole("link", { name: "Rise Bakery" }).first().click();
    await page.waitForTimeout(300);
    await expect(frame.getByRole("heading", { name: "Links" })).toBeVisible();
    expect(page.context().pages()).toHaveLength(1);
  });
});

test.describe("recovering from a mistake", () => {
  test("Discard changes goes back to what's on the site, and can be undone", async ({
    page,
    signedIn,
  }) => {
    const post = await createEntry(page, signedIn, {
      title: "Hours",
      body: "Live words",
      publish: true,
    });
    await openPost(page, signedIn, post.id);
    await retype(page, "Half my page deleted");
    await expect(saveStatus(page)).toContainText("not on your site yet", { timeout: 5000 });

    await page.getByRole("button", { name: "Discard changes" }).click();
    await expect(body(page)).toHaveText("Live words");
    await expect(saveStatus(page)).toContainText("On your site");
    await expect(page.getByText("Your changes were discarded.")).toBeVisible();

    await page.getByRole("button", { name: "Undo" }).last().click();
    await expect(body(page)).toHaveText("Half my page deleted");
    await expect(saveStatus(page)).toContainText("not on your site yet");
  });

  test("the plan's scenario: restore yesterday's page and publish it again", async ({
    page,
    signedIn,
  }) => {
    const about = await createEntry(page, signedIn, {
      type: "page",
      title: "About",
      body: "The whole story",
      publish: true,
    });
    await page.goto(`${signedIn.base}/admin/pages/${about.id}`);
    await retype(page, "Half of it");
    await expect(saveStatus(page)).toContainText("not on your site yet", { timeout: 5000 });
    await page.getByRole("button", { name: "Publish changes" }).click();
    await expect(saveStatus(page)).toContainText("On your site");

    await page.getByRole("button", { name: "History" }).click();
    const history = page.getByRole("dialog", { name: "History" });
    await history
      .getByRole("button", { name: /Published/ })
      .last()
      .click();
    await expect(page.frameLocator("iframe").getByText("The whole story")).toBeVisible();
    await history.getByRole("button", { name: "Restore this version" }).click();

    await expect(history).toHaveCount(0);
    await expect(body(page)).toHaveText("The whole story");
    await expect(saveStatus(page)).toContainText("not on your site yet");
    // Nothing moved on the site yet.
    expect(await (await page.request.get(`${signedIn.base}${about.url}`)).text()).toContain(
      "Half of it",
    );

    await page.getByRole("button", { name: "Publish changes" }).click();
    await expect(saveStatus(page)).toContainText("On your site");
    expect(await (await page.request.get(`${signedIn.base}${about.url}`)).text()).toContain(
      "The whole story",
    );
  });

  test("restoring keeps what was there, so it can be undone from History", async ({
    page,
    signedIn,
  }) => {
    const post = await createEntry(page, signedIn, { title: "Post", body: "Old", publish: true });
    await openPost(page, signedIn, post.id);
    await retype(page, "Newer words");
    await page.getByRole("button", { name: "History" }).click();
    const history = page.getByRole("dialog", { name: "History" });
    await history.getByRole("button", { name: /Published/ }).click();
    await history.getByRole("button", { name: "Restore this version" }).click();
    await expect(body(page)).toHaveText("Old");

    await page.getByRole("button", { name: "History" }).click();
    await history.getByRole("button", { name: /Before restoring/ }).click();
    await expect(page.frameLocator("iframe").getByText("Newer words")).toBeVisible();
  });

  test("Duplicate makes a separate copy", async ({ page, signedIn }) => {
    const post = await createEntry(page, signedIn, {
      title: "Original",
      body: "Same words",
      publish: true,
    });
    await openPost(page, signedIn, post.id);
    await openSettings(page);
    await page.getByRole("button", { name: "Duplicate" }).click();
    await expect(page.getByLabel("Title", { exact: true })).toHaveValue("Copy of Original");
    await expect(page).not.toHaveURL(new RegExp(post.id));
    await expect(body(page)).toHaveText("Same words");
    await expect(saveStatus(page)).toHaveText("Saved");
  });

  test("leaving with unpublished changes offers to publish them", async ({ page, signedIn }) => {
    const post = await createEntry(page, signedIn, {
      title: "Hours",
      body: "Live words",
      publish: true,
    });
    await openPost(page, signedIn, post.id);
    await retype(page, "New hours");
    await postsLink(page).click();
    await expect(page.getByText("Your changes aren't on your site yet.")).toBeVisible();
    await page.getByRole("button", { name: "Publish now" }).click();
    await expect(page.getByText("Published. Your changes are on your site.")).toBeVisible();
    expect(await (await page.request.get(`${signedIn.base}${post.url}`)).text()).toContain(
      "New hours",
    );
  });

  test("leaving with nothing waiting says nothing", async ({ page, signedIn }) => {
    const post = await createEntry(page, signedIn, { title: "Hours", publish: true });
    await openPost(page, signedIn, post.id);
    await postsLink(page).click();
    await expect(page.getByRole("heading", { name: "Posts" })).toBeVisible();
    await page.waitForTimeout(300);
    await expect(page.getByText("aren't on your site yet")).toHaveCount(0);
  });

  test("leaving someone else's unpublished changes doesn't offer to publish them", async ({
    page,
    signedIn,
  }) => {
    const post = await createEntry(page, signedIn, {
      title: "Hours",
      body: "Live words",
      publish: true,
    });
    await page.request.patch(`${signedIn.base}/api/admin/entries/${post.id}`, {
      headers: { "If-Match": String(post.rev) },
      data: {
        doc: {
          type: "doc",
          content: [{ type: "paragraph", content: [{ type: "text", text: "Maya's changes" }] }],
        },
      },
    });
    // There's no second account yet, so the editor is told those changes are Maya's.
    await page.route(`**/api/admin/entries/${post.id}`, async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      const response = await route.fetch();
      const entry = await response.json();
      await route.fulfill({
        response,
        json: { ...entry, updatedBy: { id: "maya", name: "Maya" } },
      });
    });
    await openPost(page, signedIn, post.id);
    await expect(body(page)).toHaveText("Maya's changes");
    await postsLink(page).click();
    await expect(page.getByRole("heading", { name: "Posts" })).toBeVisible();
    await page.waitForTimeout(300);
    await expect(page.getByText("aren't on your site yet")).toHaveCount(0);
  });
});

test.describe("toasts", () => {
  test("go after 8 seconds, but not while the pointer or focus is on them", async ({
    page,
    signedIn,
  }) => {
    const post = await createEntry(page, signedIn, { title: "Short lived", publish: true });
    await openPost(page, signedIn, post.id);
    await openSettings(page);
    await page.getByRole("button", { name: "Unpublish" }).click();
    const undo = page.locator(".fixed").getByRole("button", { name: "Undo" });
    await expect(undo).toBeVisible();
    await undo.hover();
    await page.waitForTimeout(9000);
    await expect(undo).toBeVisible();
    await page.mouse.move(0, 0);
    await page.waitForTimeout(8500);
    await expect(undo).toHaveCount(0);
    await expect(saveStatus(page)).toHaveText("Taken off your site. It's a draft now.");
  });
});

test.describe("taking things down", () => {
  test("Trash takes it off the site, and Undo says what happened", async ({ page, signedIn }) => {
    const post = await createEntry(page, signedIn, { title: "Binned", publish: true });
    await openPost(page, signedIn, post.id);
    await openSettings(page);
    await page.getByRole("button", { name: "Move to Trash" }).click();

    await expect(page.getByText("Moved to the Trash, and taken off your site.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Binned" })).toHaveCount(0);
    expect((await page.request.get(`${signedIn.base}${post.url}`)).status()).toBe(404);

    await page.getByRole("button", { name: "Undo" }).click();
    await expect(page.getByText("It's back as a draft. Publish it")).toBeVisible();
    await expect(page.getByRole("link", { name: "Binned" })).toBeVisible();
  });

  test("the row leaves the list at once, even on a slow connection", async ({ page, signedIn }) => {
    const post = await createEntry(page, signedIn, { title: "Binned", publish: true });
    await page.goto(`${signedIn.base}/admin/posts`);
    await page.getByRole("link", { name: "Binned" }).click();
    await page.route("**/api/admin/entries?*", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      await route.fallback();
    });
    await openSettings(page);
    await page.getByRole("button", { name: "Move to Trash" }).click();
    await expect(page.getByText("Moved to the Trash")).toBeVisible();
    await expect(page.getByRole("link", { name: "Binned" })).toHaveCount(0, { timeout: 500 });
    expect(post.url).toBeTruthy();
  });

  test("a draft that was never on the site isn't said to have been", async ({ page, signedIn }) => {
    const post = await createEntry(page, signedIn, { title: "Never published" });
    await openPost(page, signedIn, post.id);
    await openSettings(page);
    await page.getByRole("button", { name: "Move to Trash" }).click();
    await expect(page.getByText("Moved to the Trash.")).toBeVisible();
    await expect(page.getByText("taken off your site")).toHaveCount(0);
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(page.getByText("It's back as a draft.", { exact: true })).toBeVisible();
  });

  test("the Trash tab can restore things, and says when they'd go", async ({ page, signedIn }) => {
    const post = await createEntry(page, signedIn, { title: "In the bin" });
    await page.request.post(`${signedIn.base}/api/admin/entries/${post.id}/trash`, { data: {} });
    await page.goto(`${signedIn.base}/admin/posts`);
    await page.getByRole("button", { name: "Trash", exact: true }).click();
    await expect(page.getByText(/Deleted for good on/)).toBeVisible();
    await page.getByRole("button", { name: "Restore" }).click();
    await expect(page.getByText("It's back as a draft.", { exact: true })).toBeVisible();
  });

  test("Delete forever asks first, and can be called off", async ({ page, signedIn }) => {
    const post = await createEntry(page, signedIn, { title: "Really gone" });
    await page.request.post(`${signedIn.base}/api/admin/entries/${post.id}/trash`, { data: {} });
    await page.goto(`${signedIn.base}/admin/posts`);
    await page.getByRole("button", { name: "Trash", exact: true }).click();
    await page.getByRole("button", { name: "Delete forever" }).click();

    const dialog = page.getByRole("dialog", { name: 'Delete "Really gone" forever?' });
    await expect(dialog.getByRole("button", { name: "Keep it" })).toBeFocused();
    await dialog.getByRole("button", { name: "Keep it" }).click();
    await expect(page.getByText("Really gone")).toBeVisible();
    expect((await page.request.get(`${signedIn.base}/api/admin/entries/${post.id}`)).status()).toBe(
      200,
    );

    await page.getByRole("button", { name: "Delete forever" }).click();
    await dialog.getByRole("button", { name: "Delete forever" }).click();
    await expect(page.getByText("Deleted forever.")).toBeVisible();
    await expect(page.getByText("Really gone")).toHaveCount(0);
    expect((await page.request.get(`${signedIn.base}/api/admin/entries/${post.id}`)).status()).toBe(
      404,
    );
  });

  test("opening something in the Trash offers Restore rather than Publish", async ({
    page,
    signedIn,
  }) => {
    const post = await createEntry(page, signedIn, { title: "Binned" });
    await page.request.post(`${signedIn.base}/api/admin/entries/${post.id}/trash`, { data: {} });
    await openPost(page, signedIn, post.id);
    await expect(saveStatus(page)).toContainText("This is in the Trash");
    await expect(body(page)).not.toBeEditable();
    await expect(page.getByRole("button", { name: "Publish post" })).toHaveCount(0);
    await page.getByRole("button", { name: "Restore" }).click();
    await expect(page.getByRole("button", { name: "Publish post" })).toBeVisible();
    await expect(body(page)).toBeEditable();
  });

  test("Unpublish says plainly what happened, and can be undone", async ({ page, signedIn }) => {
    const post = await createEntry(page, signedIn, { title: "Short lived", publish: true });
    await openPost(page, signedIn, post.id);
    await openSettings(page);
    await page.getByRole("button", { name: "Unpublish" }).click();
    await expect(saveStatus(page)).toHaveText("Taken off your site. It's a draft now.");
    await expect(saveStatus(page)).toBeFocused();
    expect((await page.request.get(`${signedIn.base}${post.url}`)).status()).toBe(404);

    await page.getByRole("button", { name: "Undo" }).last().click();
    await expect(saveStatus(page)).toContainText("On your site");
    expect((await page.request.get(`${signedIn.base}${post.url}`)).status()).toBe(200);
  });
});

test.describe("lists", () => {
  test("pressing New post and going straight back leaves nothing behind", async ({
    page,
    signedIn,
  }) => {
    await page.goto(`${signedIn.base}/admin/posts`);
    await page.getByRole("button", { name: "New post" }).click();
    await expect(page.getByLabel("Title", { exact: true })).toBeFocused();
    await page.getByRole("link", { name: "Back to posts" }).click();
    await expect(page.getByText("No posts yet")).toBeVisible();
  });

  test("changing your mind during a slow New post doesn't drag you back", async ({
    page,
    signedIn,
  }) => {
    await page.goto(`${signedIn.base}/admin/posts`);
    await page.route("**/api/admin/entries", async (route) => {
      if (route.request().method() === "POST") {
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      await route.fallback();
    });
    await page.getByRole("button", { name: "New post" }).click();
    await page.getByRole("link", { name: "Pages", exact: true }).click();
    await page.waitForTimeout(700);
    await expect(page).toHaveURL(/\/admin\/pages$/);
  });

  test("a list that won't load offers a way to try again", async ({ page, signedIn }) => {
    await page.route("**/api/admin/entries?*", (route) => route.abort());
    await page.goto(`${signedIn.base}/admin/posts`);
    await expect(page.getByText("Can't reach Tend")).toBeVisible();
    await page.unroute("**/api/admin/entries?*");
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByText("No posts yet")).toBeVisible();
  });

  test("buttons report being offline, rather than quietly doing nothing", async ({
    page,
    signedIn,
  }) => {
    await page.goto(`${signedIn.base}/admin/posts`);
    await expect(page.getByText("No posts yet")).toBeVisible();
    await page.context().setOffline(true);
    await page.getByRole("button", { name: "New post" }).click();
    await expect(page.getByText("Can't reach Tend")).toBeVisible();
    await page.context().setOffline(false);
  });
});

test.describe("focus", () => {
  test("opening something that exists moves focus to its heading", async ({ page, signedIn }) => {
    await createEntry(page, signedIn, { title: "Existing" });
    await page.goto(`${signedIn.base}/admin/posts`);
    await page.getByRole("link", { name: "Existing" }).click();
    await expect(page.getByRole("heading", { name: "Edit post" })).toBeFocused();
  });

  test("the button just used doesn't drop keyboard focus", async ({ page, signedIn }) => {
    const post = await createEntry(page, signedIn, { title: "Draft", publish: true });
    await openPost(page, signedIn, post.id);
    await retype(page, "Changed");
    await expect(saveStatus(page)).toContainText("not on your site yet", { timeout: 5000 });
    const publish = page.getByRole("button", { name: "Publish changes" });
    await publish.focus();
    await page.keyboard.press("Enter");
    await expect(saveStatus(page)).toContainText("On your site");
    await expect(page.getByRole("button", { name: "Published" })).toBeFocused();
  });
});

test.describe("what the overview says", () => {
  test("a local site says only its owner can see it", async ({ page, signedIn }) => {
    await page.goto(`${signedIn.base}/admin/`);
    await expect(page.getByText("Your site is ready on this computer.")).toBeVisible();
  });
});
