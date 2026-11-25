import type { Page } from "@playwright/test";
import {
  bodyText,
  closeWhileDown,
  createEntry,
  expect,
  holdRequests,
  openHistory,
  openSettings,
  readEntry,
  type Site,
  test,
} from "./fixtures.ts";

// What the second independent review found going wrong, kept so it can't come back.

const SAVE_PATH = "**/api/admin/entries/*";
const body = (page: Page) => page.getByRole("textbox", { name: "Text" });
const saveStatus = (page: Page) => page.getByTestId("save-status");
const postsLink = (page: Page) => page.getByRole("link", { name: "Posts", exact: true });
const toast = (page: Page) => page.locator(".fixed");

/** The part of what the editor knows that's looked at here. */
interface EditorState {
  selection: { $from: { index(depth: number): number } };
}

async function openPost(page: Page, site: Site, id: string, kind = "posts"): Promise<void> {
  await page.goto(`${site.base}/admin/${kind}/${id}`);
  await expect(body(page)).toBeVisible();
}

async function retype(page: Page, words: string): Promise<void> {
  await body(page).click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type(words);
}

function doc(...content: unknown[]) {
  return { type: "doc", content };
}

function paragraph(words: string, marks?: unknown[]) {
  return {
    type: "paragraph",
    content: [{ type: "text", text: words, ...(marks ? { marks } : {}) }],
  };
}

async function patch(page: Page, site: Site, id: string, rev: number, data: object) {
  const reply = await page.request.patch(`${site.base}/api/admin/entries/${id}`, {
    headers: { "If-Match": String(rev) },
    data,
  });
  expect(reply.status()).toBe(200);
  return reply.json();
}

async function act(page: Page, site: Site, id: string, action: string, rev: number) {
  return (
    await page.request.post(`${site.base}/api/admin/entries/${id}/${action}`, {
      headers: { "If-Match": String(rev) },
      data: {},
    })
  ).json();
}

function failSaves(page: Page) {
  return page.route(SAVE_PATH, (route) =>
    route.request().method() === "PATCH" ? route.abort() : route.fallback(),
  );
}

function deviceRows(page: Page): Promise<{ draft: { doc: unknown } }[]> {
  return page.evaluate(
    () =>
      new Promise((resolve) => {
        const open = indexedDB.open("tend");
        open.onsuccess = () => {
          const all = open.result.transaction("drafts").objectStore("drafts").getAll();
          all.onsuccess = () => resolve(all.result);
        };
      }),
  );
}

function paste(page: Page, html: string) {
  return page.evaluate((markup) => {
    const data = new DataTransfer();
    data.setData("text/html", markup);
    document
      .querySelector('[role="textbox"][contenteditable]')
      ?.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true }));
  }, html);
}

test.describe("what's typed, when things go wrong", () => {
  test("a device that can't store anything doesn't lose the words on opening them", async ({
    page,
    signedIn,
  }) => {
    const post = await createEntry(page, signedIn, { title: "Draft", body: "On the server" });
    // Reading works, but storing is refused, as on a full disk.
    await page.addInitScript(() => {
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (...args) {
        if ((window as unknown as { refuse?: boolean }).refuse) {
          this.transaction.abort();
          throw new DOMException("full", "QuotaExceededError");
        }
        return put.apply(this, args as never);
      };
    });
    await openPost(page, signedIn, post.id);
    await page.evaluate(() => {
      (window as unknown as { refuse?: boolean }).refuse = true;
    });
    await failSaves(page);
    await retype(page, "Only in memory");
    await expect(saveStatus(page)).toContainText("only in this window", { timeout: 6000 });
    await postsLink(page).click();
    await page.getByRole("link", { name: "Open them" }).click();
    await expect(body(page)).toHaveText("Only in memory");
    await expect(page.getByRole("button", { name: "Keep these changes" })).toBeVisible();
  });

  test("words typed just before a conflict are kept on the device", async ({ page, signedIn }) => {
    const post = await createEntry(page, signedIn, { title: "T", body: "On server" });
    await openPost(page, signedIn, post.id);
    const current = await readEntry(page, signedIn, post.id);
    await patch(page, signedIn, post.id, current.rev, { doc: doc(paragraph("Theirs")) });
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(SAVE_PATH, async (route) => {
      if (route.request().method() === "PATCH") await gate;
      await route.fallback();
    });
    await retype(page, "First part");
    await page.waitForRequest((request) => request.method() === "PATCH");
    await page.keyboard.type(" LAST WORDS", { delay: 5 });
    release();
    await expect(page.getByText("You changed this on another device.")).toBeVisible();
    await expect
      .poll(async () => JSON.stringify(await deviceRows(page)))
      .toContain("First part LAST WORDS");
  });

  test("words undone while a save's answer is lost don't stay on the server", async ({
    page,
    signedIn,
  }) => {
    const post = await createEntry(page, signedIn, { title: "T", body: "On server" });
    await openPost(page, signedIn, post.id);
    let first = true;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(SAVE_PATH, async (route) => {
      if (route.request().method() !== "PATCH" || !first) return route.fallback();
      first = false;
      await route.fetch();
      await gate;
      return route.abort();
    });
    await body(page).click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type(" SECRET");
    await page.waitForRequest((request) => request.method() === "PATCH");
    await page.keyboard.press("ControlOrMeta+z");
    await expect(body(page)).toHaveText("On server");
    release();
    await expect(saveStatus(page)).toHaveText("Saved", { timeout: 10_000 });
    expect(bodyText(await readEntry(page, signedIn, post.id))).toBe("On server");
  });

  test("the status doesn't stay on Offline when there's nothing left to send", async ({
    page,
    signedIn,
  }) => {
    const post = await createEntry(page, signedIn, { title: "T", body: "Base" });
    await openPost(page, signedIn, post.id);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let failing = true;
    await page.route(SAVE_PATH, async (route) => {
      if (route.request().method() !== "PATCH" || !failing) return route.fallback();
      await gate;
      return route.abort();
    });
    await body(page).click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type(" x");
    await page.waitForRequest((request) => request.method() === "PATCH");
    await page.keyboard.press("ControlOrMeta+z");
    failing = false;
    release();
    await expect(saveStatus(page)).toHaveText("Saved", { timeout: 10_000 });
    expect(bodyText(await readEntry(page, signedIn, post.id))).toBe("Base");
  });

  test("typing offline doesn't hammer the server, or keep repeating Offline aloud", async ({
    page,
    signedIn,
  }) => {
    test.setTimeout(60_000);
    const post = await createEntry(page, signedIn, { title: "T", body: "Base" });
    await openPost(page, signedIn, post.id);
    let sent = 0;
    await page.route(SAVE_PATH, (route) => {
      if (route.request().method() !== "PATCH") return route.fallback();
      sent++;
      return route.abort();
    });
    await page.evaluate(() => {
      const region = document.querySelector('p.sr-only[role="status"]');
      const said: string[] = [];
      (window as unknown as { said: string[] }).said = said;
      if (region) {
        new MutationObserver(() => {
          if (region.textContent) said.push(region.textContent);
        }).observe(region, { childList: true, characterData: true, subtree: true });
      }
    });
    await body(page).click();
    const started = Date.now();
    while (Date.now() - started < 16_000) {
      await page.keyboard.type("a");
      await page.waitForTimeout(350);
    }
    // At most one save every 10 s while typing, then retries 2, 4 and 8 seconds apart.
    expect(sent).toBeLessThanOrEqual(4);
    const said = await page.evaluate(() => (window as unknown as { said: string[] }).said);
    expect(said.filter((words) => words.includes("Offline"))).toHaveLength(1);
  });

  test("Discard whose answer was lost doesn't leave the screen and server disagreeing", async ({
    page,
    signedIn,
  }) => {
    const post = await createEntry(page, signedIn, { title: "T", body: "On site", publish: true });
    await openPost(page, signedIn, post.id);
    await retype(page, "My unpublished words");
    await expect(saveStatus(page)).toContainText("not on your site yet", { timeout: 6000 });
    let first = true;
    await page.route("**/discard-changes", async (route) => {
      if (!first) return route.fallback();
      first = false;
      await route.fetch();
      return route.abort();
    });
    await page.getByRole("button", { name: "Discard changes" }).click();
    await expect(page.getByText("Can't reach Tend").first()).toBeVisible();
    // The screen still shows the words, so the server gets them back.
    await expect
      .poll(async () => bodyText(await readEntry(page, signedIn, post.id)), { timeout: 10_000 })
      .toBe("My unpublished words");
    await expect(saveStatus(page)).toContainText("not on your site yet");

    // And a second Discard then keeps those words for Undo, not the live ones.
    await page.getByRole("button", { name: "Discard changes" }).click();
    await expect(body(page)).toHaveText("On site");
    await toast(page).getByRole("button", { name: "Undo" }).click();
    await expect(body(page)).toHaveText("My unpublished words");
  });

  test("Write another doesn't take away words typed while it's on its way", async ({
    page,
    signedIn,
  }) => {
    const post = await createEntry(page, signedIn, { title: "First" });
    await openPost(page, signedIn, post.id);
    await page.getByRole("button", { name: "Publish post" }).click();
    await page.getByRole("button", { name: "Publish post now" }).click();
    await page.route("**/api/admin/entries", async (route) => {
      if (route.request().method() === "POST") await new Promise((done) => setTimeout(done, 1000));
      await route.fallback();
    });
    await page.getByRole("button", { name: "Write another" }).click();
    await page.keyboard.press("Escape");
    await expect(body(page)).not.toBeEditable();
  });
});

test.describe("leaving with a choice still to make", () => {
  test("doesn't offer to publish, which could only be refused", async ({ page, signedIn }) => {
    const post = await createEntry(page, signedIn, { title: "T", body: "Live", publish: true });
    await openPost(page, signedIn, post.id);
    await retype(page, "Mine");
    await expect(saveStatus(page)).toContainText("not on your site yet", { timeout: 6000 });
    const current = await readEntry(page, signedIn, post.id);
    await patch(page, signedIn, post.id, current.rev, { doc: doc(paragraph("Theirs")) });
    await retype(page, "Mine again");
    await expect(page.getByText("You changed this on another device.")).toBeVisible({
      timeout: 6000,
    });
    await postsLink(page).click();
    await expect(page.getByRole("heading", { name: "Posts" })).toBeVisible();
    await page.waitForTimeout(500);
    await expect(page.getByRole("button", { name: "Publish now" })).toHaveCount(0);
  });
});

test.describe("restoring from the Trash", () => {
  test("shows newer words saved elsewhere, rather than saving over them", async ({
    page,
    signedIn,
  }) => {
    const post = await createEntry(page, signedIn, { title: "T", body: "Older words" });
    await act(page, signedIn, post.id, "trash", post.rev);
    await openPost(page, signedIn, post.id);
    // Restored and changed in another tab meanwhile.
    await page.request.post(`${signedIn.base}/api/admin/entries/${post.id}/restore`, { data: {} });
    const now = await readEntry(page, signedIn, post.id);
    await patch(page, signedIn, post.id, now.rev, { doc: doc(paragraph("NEWER from elsewhere")) });

    await page.getByRole("button", { name: "Restore" }).click();
    await expect(body(page)).toHaveText("NEWER from elsewhere");
    await page.waitForTimeout(2500);
    expect(bodyText(await readEntry(page, signedIn, post.id))).toBe("NEWER from elsewhere");
  });

  test("a copy from this device that's older asks before going over newer words", async ({
    page,
    signedIn,
    context,
  }) => {
    const post = await createEntry(page, signedIn, { title: "T", body: "On the server" });
    await openPost(page, signedIn, post.id);
    await failSaves(page);
    await retype(page, "Yesterday's copy");
    await expect(saveStatus(page)).toContainText("Offline", { timeout: 6000 });
    await closeWhileDown(signedIn, page);
    const again = await context.newPage();
    const current = await readEntry(again, signedIn, post.id);
    const later = await patch(again, signedIn, post.id, current.rev, {
      doc: doc(paragraph("Written later on my phone")),
    });
    await act(again, signedIn, post.id, "trash", later.rev);

    await openPost(again, signedIn, post.id);
    await again.getByRole("button", { name: "Restore" }).click();
    await again.getByRole("button", { name: "Keep these changes" }).click();
    await expect(again.getByText("You changed this on another device.")).toBeVisible({
      timeout: 6000,
    });
    expect(bodyText(await readEntry(again, signedIn, post.id))).toBe("Written later on my phone");
  });
});

test.describe("Undo after leaving", () => {
  test("Unpublish's Undo still works when the toast arrives on the list", async ({
    page,
    signedIn,
  }) => {
    const post = await createEntry(page, signedIn, { title: "T", body: "Live", publish: true });
    await openPost(page, signedIn, post.id);
    const answer = await holdRequests(page, "**/unpublish");
    await openSettings(page);
    await page.getByRole("button", { name: "Unpublish" }).click();
    await postsLink(page).click();
    // The answer comes once the list is showing. An Undo already showing when the editor
    // closes goes with it, so arriving first would be a different test.
    await expect(page.getByRole("heading", { name: "Posts", level: 1 })).toBeVisible();
    answer();
    await toast(page).getByRole("button", { name: "Undo" }).click();
    await expect(page.getByText("It's back on your site.")).toBeVisible();
    expect((await readEntry(page, signedIn, post.id)).url).toBe(post.url);
  });
});

test.describe("tabs and the notice", () => {
  test("the notice appears after leaving, even if another tab saved meanwhile", async ({
    page,
    signedIn,
    context,
  }) => {
    const first = await createEntry(page, signedIn, { title: "A", body: "A" });
    const second = await createEntry(page, signedIn, { title: "B", body: "B" });
    await openPost(page, signedIn, first.id);
    const other = await context.newPage();
    await openPost(other, signedIn, second.id);
    await retype(other, "B more");
    await expect(saveStatus(other)).toHaveText("Saved", { timeout: 8000 });
    await failSaves(page);
    await retype(page, "A typed");
    await postsLink(page).click();
    await expect(page.getByRole("link", { name: "Open them" })).toBeVisible();
  });

  test("the deleted-item screen doesn't also link to itself", async ({ page, signedIn }) => {
    const post = await createEntry(page, signedIn, { title: "Gone", body: "x" });
    await openPost(page, signedIn, post.id);
    await failSaves(page);
    await retype(page, "Kept copy");
    await expect(saveStatus(page)).toContainText("Offline", { timeout: 6000 });
    await postsLink(page).click();
    await page.unroute(SAVE_PATH);
    const current = await readEntry(page, signedIn, post.id);
    await act(page, signedIn, post.id, "trash", current.rev);
    await page.request.delete(`${signedIn.base}/api/admin/entries/${post.id}`, { data: {} });
    await page.goto(`${signedIn.base}/admin/posts/${post.id}`);
    await expect(page.getByText("This has been deleted")).toBeVisible();
    await expect(page.getByRole("link", { name: "Open them" })).toHaveCount(0);
  });

  test("throwing a kept copy away can be undone", async ({ page, signedIn, context }) => {
    const post = await createEntry(page, signedIn, { title: "Saved title", body: "On server" });
    await openPost(page, signedIn, post.id);
    await failSaves(page);
    await page.getByLabel("Title", { exact: true }).fill("Kept title");
    await retype(page, "Kept copy words");
    await expect(saveStatus(page)).toContainText("Offline", { timeout: 6000 });
    await closeWhileDown(signedIn, page);
    const again = await context.newPage();
    await openPost(again, signedIn, post.id);
    await again.getByRole("button", { name: "Go back to the saved version" }).click();
    await expect(body(again)).toHaveText("On server");
    await toast(again).getByRole("button", { name: "Undo" }).click();
    await expect(body(again)).toHaveText("Kept copy words");
    await expect(again.getByLabel("Title", { exact: true })).toHaveValue("Kept title");
    await expect(again.getByRole("button", { name: "Keep these changes" })).toBeVisible();
    // Back to waiting for a decision, so it isn't saved behind the person's back, not even
    // on leaving. It stays on this device, and the notice says so.
    await postsLink(again).click();
    await expect(again.getByRole("link", { name: "Open them" })).toBeVisible();
    expect(bodyText(await readEntry(again, signedIn, post.id))).toBe("On server");
  });

  test("looking at a kept copy in Preview doesn't decide to keep it", async ({
    page,
    signedIn,
    context,
  }) => {
    const post = await createEntry(page, signedIn, { title: "T", body: "On the server" });
    await openPost(page, signedIn, post.id);
    await failSaves(page);
    await retype(page, "Old copy");
    await expect(saveStatus(page)).toContainText("Offline", { timeout: 6000 });
    await closeWhileDown(signedIn, page);
    const again = await context.newPage();
    await openPost(again, signedIn, post.id);
    await expect(again.getByRole("button", { name: "Preview" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await again.getByRole("button", { name: "Preview" }).click({ force: true });
    await expect(again.getByRole("button", { name: "Go back to the saved version" })).toBeVisible();
    expect(bodyText(await readEntry(again, signedIn, post.id))).toBe("On the server");
  });
});

test.describe("reviewing and restoring", () => {
  test("a page linking to hundreds of things isn't told they're deleted", async ({
    page,
    signedIn,
  }) => {
    test.setTimeout(90_000);
    const ids: string[] = [];
    for (let index = 0; index < 205; index++) {
      const created = await (
        await page.request.post(`${signedIn.base}/api/admin/entries`, { data: { type: "post" } })
      ).json();
      ids.push(created.id);
    }
    const post = await createEntry(page, signedIn, { title: "Index", body: "" });
    await patch(page, signedIn, post.id, post.rev, {
      doc: doc(
        ...ids.map((id) => paragraph("x", [{ type: "link", attrs: { href: `entry:${id}` } }])),
      ),
    });
    await openPost(page, signedIn, post.id);
    await page.getByRole("button", { name: "Publish post" }).click();
    const review = page.getByRole("dialog", { name: "Ready to publish?" });
    await expect(review.getByText(/isn't on your site/).first()).toBeVisible();
    await expect(review.getByText("A link goes to something that's been deleted")).toHaveCount(0);
    // And a draft with no title is called Untitled, not "".
    await expect(review.getByText('"Untitled" isn\'t on your site').first()).toBeVisible();
  });

  test("restoring what's already on the site says so, not to publish it", async ({
    page,
    signedIn,
  }) => {
    const post = await createEntry(page, signedIn, {
      title: "T",
      body: "Live words",
      publish: true,
    });
    await patch(page, signedIn, post.id, post.rev, { doc: doc(paragraph("Newer edit")) });
    await openPost(page, signedIn, post.id);
    await openHistory(page);
    const history = page.getByRole("dialog", { name: "History" });
    await history.getByRole("button", { name: /On your site/ }).click();
    await history.getByRole("button", { name: "Restore this version" }).click();
    await expect(page.getByText("It's already what's on your site.")).toBeVisible();
    await expect(saveStatus(page)).toContainText("On your site");
  });

  test("the toast saying to publish goes once that's been done", async ({ page, signedIn }) => {
    const post = await createEntry(page, signedIn, {
      title: "T",
      body: "Live words",
      publish: true,
    });
    await patch(page, signedIn, post.id, post.rev, { doc: doc(paragraph("Newer edit")) });
    await openPost(page, signedIn, post.id);
    await retype(page, "Newest edit");
    await expect(saveStatus(page)).toContainText("not on your site yet", { timeout: 6000 });
    await openHistory(page);
    const history = page.getByRole("dialog", { name: "History" });
    await history
      .getByRole("button", { name: /Saved automatically/ })
      .first()
      .click();
    await history.getByRole("button", { name: "Restore this version" }).click();
    // Wherever it shows: toasts move into a dialog while one is open.
    const nudge = page.getByText("Publish changes to put it on your site.");
    await expect(nudge).toBeVisible();
    await page.getByRole("button", { name: "Publish changes" }).click();
    await expect(saveStatus(page)).toContainText("On your site");
    await expect(nudge).toBeHidden();
  });

  test("History reaches versions past the first hundred, and Restore is close by keyboard", async ({
    page,
    signedIn,
  }) => {
    test.setTimeout(90_000);
    const post = await createEntry(page, signedIn, { title: "T", body: "v0", publish: true });
    let rev = post.rev;
    for (let index = 1; index <= 101; index++) {
      const saved = await patch(page, signedIn, post.id, rev, { doc: doc(paragraph(`v${index}`)) });
      rev = (await act(page, signedIn, post.id, "publish", saved.rev)).rev;
    }
    await openPost(page, signedIn, post.id);
    await openHistory(page);
    const history = page.getByRole("dialog", { name: "History" });
    await expect(history.getByRole("button", { name: /Published/ })).toHaveCount(100);
    await history.getByRole("button", { name: "Show older versions" }).click();
    await expect(history.getByRole("button", { name: /Published/ })).toHaveCount(102);

    const first = history.getByRole("button", { name: /Published/ }).first();
    await first.focus();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(history.locator('p.sr-only[role="status"]')).toContainText(
      "Showing the version from",
    );
    for (let presses = 0; presses < 3; presses++) {
      await page.keyboard.press("Tab");
      if (
        await history
          .getByRole("button", { name: "Restore this version" })
          .evaluate((element) => element === document.activeElement)
      ) {
        return;
      }
    }
    throw new Error("Restore this version wasn't reached within three presses of Tab");
  });
});

test.describe("the editor itself", () => {
  test("opening something unchanged never flashes Saving", async ({ page, signedIn }) => {
    const created = await (
      await page.request.post(`${signedIn.base}/api/admin/entries`, { data: { type: "post" } })
    ).json();
    const saved = await patch(page, signedIn, created.id, created.rev, {
      title: "T",
      doc: doc({
        type: "heading",
        attrs: { level: 2 },
        content: [{ type: "text", text: "Ends in a heading" }],
      }),
    });
    await act(page, signedIn, created.id, "publish", saved.rev);
    await page.addInitScript(() => {
      const seen: string[] = [];
      (window as unknown as { seen: string[] }).seen = seen;
      new MutationObserver(() => {
        const text = document.querySelector('[data-testid="save-status"]')?.textContent;
        if (text && seen.at(-1) !== text) seen.push(text);
      }).observe(document, { childList: true, subtree: true, characterData: true });
    });
    await openPost(page, signedIn, created.id);
    await page.waitForTimeout(1200);
    const seen = await page.evaluate(() => (window as unknown as { seen: string[] }).seen);
    expect(seen.join("|")).not.toContain("Saving");
  });

  test("the status settles after an action with nothing to save", async ({ page, signedIn }) => {
    const post = await createEntry(page, signedIn, { title: "T", body: "Base" });
    await openPost(page, signedIn, post.id);
    await body(page).click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type("y");
    await page.keyboard.press("Backspace");
    await page.evaluate(() => {
      [...document.querySelectorAll("button")]
        .find((button) => button.textContent === "Preview")
        ?.click();
    });
    await page.getByRole("dialog", { name: "Preview" }).waitFor();
    await page.keyboard.press("Escape");
    await expect(saveStatus(page)).toHaveText("Saved");
  });

  test("a second click inside a link places the cursor", async ({ page, signedIn }) => {
    const created = await (
      await page.request.post(`${signedIn.base}/api/admin/entries`, { data: { type: "post" } })
    ).json();
    await patch(page, signedIn, created.id, created.rev, {
      title: "T",
      doc: doc({
        type: "paragraph",
        content: [
          { type: "text", text: "Hi " },
          {
            type: "text",
            text: "some linked words here",
            marks: [{ type: "link", attrs: { href: "https://example.com" } }],
          },
        ],
      }),
    });
    await openPost(page, signedIn, created.id);
    const link = page.locator(".tend-prose a");
    await link.click({ position: { x: 20, y: 5 } });
    await link.click({ position: { x: 60, y: 5 } });
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("");
  });

  test("a long unbroken button label wraps, in the admin and on the site", async ({
    page,
    signedIn,
  }) => {
    const label = "https://example.com/menu/seasonal/breads/rye-and-sourdough";
    const created = await (
      await page.request.post(`${signedIn.base}/api/admin/entries`, { data: { type: "post" } })
    ).json();
    const saved = await patch(page, signedIn, created.id, created.rev, {
      title: "T",
      doc: doc({ type: "button", attrs: { href: "/x", label } }),
    });
    const published = await act(page, signedIn, created.id, "publish", saved.rev);
    await page.setViewportSize({ width: 320, height: 700 });
    const fits = () =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      );
    await openPost(page, signedIn, created.id);
    expect(await fits()).toBe(true);
    await page.goto(`${signedIn.base}${published.url}`);
    expect(await fits()).toBe(true);
  });

  test("pasted table rows stay readable", async ({ page, signedIn }) => {
    const post = await createEntry(page, signedIn, { title: "T", body: "" });
    await openPost(page, signedIn, post.id);
    await body(page).click();
    await paste(
      page,
      "<table><tr><td>Mon</td><td>9-5</td></tr><tr><td>Tue</td><td>9-5</td></tr></table>",
    );
    await expect(body(page).locator("p").nth(0)).toHaveText("Mon · 9-5");
    await expect(body(page).locator("p").nth(1)).toHaveText("Tue · 9-5");
  });

  test("dismissing a notice puts focus back in the writing, where it was", async ({
    page,
    signedIn,
  }) => {
    const created = await (
      await page.request.post(`${signedIn.base}/api/admin/entries`, { data: { type: "post" } })
    ).json();
    await patch(page, signedIn, created.id, created.rev, {
      title: "T",
      doc: doc(
        ...Array.from({ length: 30 }, (_, index) => paragraph(`Paragraph ${index} `.repeat(6))),
      ),
    });
    await openPost(page, signedIn, created.id);
    // WebKit tells the editor where the cursor is a moment after the key or the press that moved
    // it, and what's pasted here comes sooner than a person could paste it.
    const paragraphWithCursor = () =>
      body(page).evaluate((element) => {
        const { state } = (element as unknown as { editor: { state: EditorState } }).editor;
        return state.selection.$from.index(0);
      });
    const dismissed = async () => {
      await paste(page, '<img src="/a.png">');
      const scrolled = await page.evaluate(() => scrollY);
      await page.getByRole("button", { name: "OK" }).click();
      await expect(body(page)).toBeFocused();
      expect(await page.evaluate(() => scrollY)).toBe(scrolled);
    };
    await body(page).click();
    await page.keyboard.press("ControlOrMeta+End");
    await expect.poll(paragraphWithCursor).toBe(29);
    await dismissed();
    await page.keyboard.type("more");
    await expect(body(page).locator("p").last()).toContainText("more");

    // And right under the bars, where pasting brings back a cursor that was out of sight.
    await body(page).locator("p").nth(9).click();
    await expect.poll(paragraphWithCursor).toBe(9);
    await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
    await dismissed();
    await page.keyboard.type("again");
    await expect(body(page).locator("p").nth(9)).toContainText("again");
  });

  test("closing a button's dialog hands focus back to its Edit button, in place", async ({
    page,
    signedIn,
  }) => {
    const created = await (
      await page.request.post(`${signedIn.base}/api/admin/entries`, { data: { type: "post" } })
    ).json();
    await patch(page, signedIn, created.id, created.rev, {
      title: "T",
      doc: doc(
        ...Array.from({ length: 30 }, (_, index) => paragraph(`Paragraph ${index} `.repeat(6))),
        { type: "button", attrs: { href: "/x", label: "Go" } },
      ),
    });
    await openPost(page, signedIn, created.id);
    await body(page).click({ position: { x: 20, y: 30 } });
    const edit = page.getByRole("button", { name: 'Edit "Go" button' });
    await edit.scrollIntoViewIfNeeded();
    await edit.focus();
    const before = await page.evaluate(() => scrollY);
    await page.keyboard.press("Enter");
    await page.locator("dialog").waitFor();
    await page.keyboard.press("Escape");
    await expect(edit).toBeFocused();
    expect(Math.abs((await page.evaluate(() => scrollY)) - before)).toBeLessThan(50);
  });

  test("opening the link dialog on a link to a page keeps focus inside it", async ({
    page,
    signedIn,
  }) => {
    const target = await createEntry(page, signedIn, { title: "About", type: "page" });
    const created = await (
      await page.request.post(`${signedIn.base}/api/admin/entries`, { data: { type: "post" } })
    ).json();
    await patch(page, signedIn, created.id, created.rev, {
      title: "T",
      doc: doc(
        paragraph("linked words", [{ type: "link", attrs: { href: `entry:${target.id}` } }]),
      ),
    });
    await openPost(page, signedIn, created.id);
    await body(page).locator("a").click();
    await page.keyboard.press("ControlOrMeta+k");
    const dialog = page.getByRole("dialog", { name: "Add a link" });
    await expect(dialog.getByText('Goes to "About"')).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Change" })).toBeFocused();
  });

  test("an address with a space in the name is refused in the dialog, not later", async ({
    page,
    signedIn,
  }) => {
    const post = await createEntry(page, signedIn, { title: "T", body: "Words" });
    await openPost(page, signedIn, post.id);
    await body(page).click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("ControlOrMeta+k");
    const dialog = page.getByRole("dialog", { name: "Add a link" });
    await dialog.getByLabel(/Search your pages/).fill("https://my bakery.com");
    await page.keyboard.press("Enter");
    await expect(dialog.getByText("That doesn't look like an address.")).toBeVisible();
  });

  test("addresses with a port are understood", async ({ page, signedIn }) => {
    const post = await createEntry(page, signedIn, { title: "T", body: "Words" });
    await openPost(page, signedIn, post.id);
    await body(page).click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByLabel(/Search your pages/).fill("example.com:8080/menu");
    await page.keyboard.press("Enter");
    await expect(body(page).locator("a")).toHaveAttribute("href", "https://example.com:8080/menu");
  });

  test('"/di" means Divider', async ({ page, signedIn }) => {
    const post = await createEntry(page, signedIn, { title: "T", body: "" });
    await openPost(page, signedIn, post.id);
    await body(page).click();
    await page.keyboard.type("/di");
    await expect(page.getByRole("option").first()).toHaveText("Divider");
    await page.keyboard.press("Enter");
    await expect(body(page).locator("hr")).toBeVisible();
  });

  test("a big intro's Undo brings it back even after more typing", async ({ page, signedIn }) => {
    const entry = await createEntry(page, signedIn, { type: "page", title: "Intro", body: "" });
    await page.goto(`${signedIn.base}/admin/pages/${entry.id}`);
    await body(page).click();
    await page.keyboard.type("/intro");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Important words");
    await page.getByRole("button", { name: "Remove" }).click();
    await expect(body(page)).toBeFocused();
    await page.keyboard.type("typed after");
    await toast(page).getByRole("button", { name: "Undo" }).click();
    await expect(body(page).locator("h2")).toHaveText("Important words");
    await expect(body(page)).toContainText("typed after");
  });

  test("an empty line above a big intro can be deleted", async ({ page, signedIn }) => {
    const entry = await createEntry(page, signedIn, { type: "page", title: "Intro", body: "" });
    await patch(page, signedIn, entry.id, entry.rev, {
      doc: doc(
        { type: "paragraph" },
        {
          type: "section",
          attrs: { kind: "intro" },
          content: [paragraph("Inside")],
        },
      ),
    });
    await page.goto(`${signedIn.base}/admin/pages/${entry.id}`);
    await body(page).locator("> p").first().click();
    await page.waitForTimeout(100);
    await page.keyboard.press("Delete");
    await expect(body(page).locator("> *").first()).not.toHaveText("");
  });

  test("the selection toolbar goes once focus has moved on, and never covers the toolbar", async ({
    page,
    signedIn,
  }) => {
    const post = await createEntry(page, signedIn, {
      title: "T",
      body: "First line with some words",
    });
    await openPost(page, signedIn, post.id);
    await body(page)
      .locator("p")
      .first()
      .dblclick({ position: { x: 10, y: 5 } });
    const underline = page.getByRole("button", { name: "Underline" });
    await expect(underline).toBeVisible();
    const toolbarUndo = page.locator("fieldset").getByRole("button", { name: "Undo" });
    const covered = await toolbarUndo.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return !element.contains(top);
    });
    expect(covered).toBe(false);

    await underline.focus();
    for (let presses = 0; presses < 12; presses++) await page.keyboard.press("Tab");
    await expect(underline).toBeHidden();
  });

  test("a post title starting with blog/ shows the address it will really have", async ({
    page,
    signedIn,
  }) => {
    const post = await createEntry(page, signedIn, { title: "blog/Second" });
    await openPost(page, signedIn, post.id);
    await openSettings(page);
    const real = (await readEntry(page, signedIn, post.id)).address.path;
    await expect(page.getByText(`This will be ${real}.`)).toBeVisible();
  });
});

test.describe("lists", () => {
  test("go past the first hundred", async ({ page, signedIn }) => {
    test.setTimeout(90_000);
    for (let index = 0; index < 101; index++) {
      await createEntry(page, signedIn, { title: `Post ${String(index).padStart(3, "0")}` });
    }
    await page.goto(`${signedIn.base}/admin/posts`);
    await expect(page.getByRole("link", { name: "Post 100" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Post 000" })).toHaveCount(0);
    await page.getByRole("button", { name: "Show more" }).click();
    await expect(page.getByRole("link", { name: "Post 000" })).toBeVisible();
  });

  test("restoring from a long Trash keeps your place", async ({ page, signedIn }) => {
    test.setTimeout(60_000);
    for (let index = 0; index < 30; index++) {
      const post = await createEntry(page, signedIn, { title: `Binned ${index}` });
      await page.request.post(`${signedIn.base}/api/admin/entries/${post.id}/trash`, { data: {} });
    }
    await page.goto(`${signedIn.base}/admin/posts`);
    await page.getByRole("button", { name: /^Trash/ }).click();
    const restore = page.getByRole("button", { name: "Restore" });
    await restore.nth(20).focus();
    await page.keyboard.press("Enter");
    // Once the row has actually gone, focus is on the one that took its place.
    await expect(page.locator("[data-entry-row]")).toHaveCount(29);
    await expect(page.getByRole("heading", { name: "Posts" })).not.toBeFocused();
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Restore");
    expect(await page.evaluate(() => scrollY)).toBeGreaterThan(0);
  });
});
