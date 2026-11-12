import type { Page, Route } from "@playwright/test";
import { bodyText, createEntry, expect, readEntry, type Site, signIn, test } from "./fixtures.ts";

// Each of these is something an independent review found going wrong, kept so it can't return.

const SAVE_PATH = "**/api/admin/entries/*";

function isSave(route: Route): boolean {
  return route.request().method() === "PATCH";
}

async function failSaves(page: Page): Promise<void> {
  await page.route(SAVE_PATH, (route) => (isSave(route) ? route.abort() : route.fallback()));
}

const body = (page: Page) => page.getByRole("textbox", { name: "Text" });
const saveStatus = (page: Page) => page.getByTestId("save-status");
const announcements = (page: Page) => page.locator('p.sr-only[role="status"]').first();
const postsLink = (page: Page) => page.getByRole("link", { name: "Posts", exact: true });

async function openPost(page: Page, site: Site, id: string): Promise<void> {
  await page.goto(`${site.base}/admin/posts/${id}`);
  await expect(body(page)).toBeVisible();
}

async function openSettings(page: Page): Promise<void> {
  const summary = page.getByText("Address, summary and more");
  if ((await page.locator("details[open]").count()) === 0) await summary.click();
}

async function retype(page: Page, words: string): Promise<void> {
  await body(page).click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type(words);
}

async function paste(page: Page, html: string): Promise<void> {
  await body(page).click();
  await page.evaluate((markup) => {
    const data = new DataTransfer();
    data.setData("text/html", markup);
    document
      .querySelector('[role="textbox"][contenteditable]')
      ?.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true }));
  }, html);
}

const active = (page: Page) =>
  page.evaluate(() => ({
    tag: document.activeElement?.tagName,
    text: document.activeElement?.textContent?.slice(0, 60),
  }));

test.describe("a window that has closed", () => {
  test("never saves again, however long its save takes to fail", async ({ page, signedIn }) => {
    const post = await createEntry(page, signedIn, { title: "Draft", body: "On the server" });
    await openPost(page, signedIn, post.id);

    const sent: string[] = [];
    let failing = true;
    await page.route(SAVE_PATH, async (route) => {
      if (!isSave(route)) return route.fallback();
      sent.push(bodyText({ data: route.request().postDataJSON() }));
      if (!failing) return route.fallback();
      // Still on its way when the person leaves, and it fails after they've gone.
      await new Promise((resolve) => setTimeout(resolve, 800));
      return route.abort();
    });
    await retype(page, "OLD words");
    await page.keyboard.press("ControlOrMeta+s");
    await postsLink(page).click();
    await expect(page.getByRole("heading", { name: "Posts" })).toBeVisible();
    await page.getByRole("link", { name: "Open them" }).click();

    failing = false;
    await page.getByRole("button", { name: "Keep these changes" }).waitFor();
    await retype(page, "NEW words, far better");
    await expect(saveStatus(page)).toHaveText("Saved", { timeout: 10_000 });
    const before = sent.length;
    // Longer than any retry that might still be waiting to go.
    await page.waitForTimeout(5000);
    expect(sent.slice(before)).toEqual([]);
    expect(bodyText(await readEntry(page, signedIn, post.id))).toBe("NEW words, far better");
  });

  test("doesn't undo throwing a draft away", async ({ page, signedIn }) => {
    const post = await createEntry(page, signedIn, { title: "Draft", body: "On the server" });
    await openPost(page, signedIn, post.id);
    let failing = true;
    await page.route(SAVE_PATH, async (route) => {
      if (!isSave(route)) return route.fallback();
      if (!failing) return route.fallback();
      await new Promise((resolve) => setTimeout(resolve, 800));
      return route.abort();
    });
    await retype(page, "OLD words");
    await page.keyboard.press("ControlOrMeta+s");
    await postsLink(page).click();
    await page.getByRole("link", { name: "Open them" }).click();
    failing = false;
    await page.getByRole("button", { name: "Go back to the saved version" }).click();
    await page.waitForTimeout(5000);
    expect(bodyText(await readEntry(page, signedIn, post.id))).toBe("On the server");
  });
});

test.describe("signing out", () => {
  test("if it fails, the editor carries on working", async ({ page, signedIn }) => {
    const post = await createEntry(page, signedIn, { title: "Draft", body: "On the server" });
    await openPost(page, signedIn, post.id);
    await page.route("**/api/auth/logout", (route) => route.abort());
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByText("Can't reach Tend").first()).toBeVisible();

    await retype(page, "Still writing");
    await expect(saveStatus(page)).toHaveText("Saved", { timeout: 5000 });
    expect(bodyText(await readEntry(page, signedIn, post.id))).toBe("Still writing");
  });

  test("a second try after that still saves first", async ({ page, signedIn }) => {
    const post = await createEntry(page, signedIn, { title: "Draft", body: "On the server" });
    await openPost(page, signedIn, post.id);
    await page.route("**/api/auth/logout", (route) => route.abort());
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByText("Can't reach Tend").first()).toBeVisible();
    await page.unroute("**/api/auth/logout");

    await retype(page, "Last words");
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await signIn(page, signedIn);
    expect(bodyText(await readEntry(page, signedIn, post.id))).toBe("Last words");
  });

  test("if the save before it fails, saving carries on trying", async ({ page, signedIn }) => {
    const post = await createEntry(page, signedIn, { title: "Draft", body: "On the server" });
    await openPost(page, signedIn, post.id);
    await failSaves(page);
    await retype(page, "Worth keeping");
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(saveStatus(page)).toContainText("Offline", { timeout: 5000 });
    await page.unroute(SAVE_PATH);
    await expect(saveStatus(page)).toHaveText("Saved", { timeout: 10_000 });
  });

  test("clears what the last person was looking at", async ({ page, signedIn }) => {
    await createEntry(page, signedIn, { title: "Private plans" });
    await page.goto(`${signedIn.base}/admin/posts`);
    await expect(page.getByRole("link", { name: "Private plans" })).toBeVisible();
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();

    await page.getByLabel("Email").fill("sam@example.com");
    await page.getByLabel("Password", { exact: true }).fill("maple-river-candle-stone-orbit");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("link", { name: "Overview" })).toBeVisible();
    await page.route("**/api/admin/entries?*", (route) => route.abort());
    await postsLink(page).click();
    await expect(page.getByText("Can't reach Tend").first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Private plans" })).toHaveCount(0);
  });
});

test.describe("two tabs", () => {
  test("each saving over the other raises a conflict, and never loses words quietly", async ({
    page,
    signedIn,
    context,
  }) => {
    const post = await createEntry(page, signedIn, { title: "Draft", body: "Start" });
    await openPost(page, signedIn, post.id);
    const second = await context.newPage();
    await openPost(second, signedIn, post.id);

    await retype(page, "From the first tab");
    await expect(saveStatus(page)).toHaveText("Saved", { timeout: 5000 });
    await retype(second, "From the second tab");
    await expect(second.getByText("You changed this on another device.")).toBeVisible({
      timeout: 5000,
    });
    expect(bodyText(await readEntry(page, signedIn, post.id))).toBe("From the first tab");
  });

  test("a copy still in use by another tab isn't offered, or noted, as left behind", async ({
    page,
    signedIn,
    context,
  }) => {
    const post = await createEntry(page, signedIn, { title: "Draft", body: "On the server" });
    await openPost(page, signedIn, post.id);
    await failSaves(page);
    await retype(page, "Typed in the first tab");
    await expect(saveStatus(page)).toContainText("Offline", { timeout: 5000 });

    const second = await context.newPage();
    await second.goto(`${signedIn.base}/admin/posts`);
    await expect(second.getByRole("heading", { name: "Posts" })).toBeVisible();
    await expect(second.getByText("haven't reached")).toHaveCount(0);
    await openPost(second, signedIn, post.id);
    await expect(body(second)).toHaveText("On the server");
    await expect(second.getByText("hadn't reached the server")).toHaveCount(0);

    // Once that tab has gone, its copy really is left behind.
    await page.close();
    await second.goto(`${signedIn.base}/admin/posts/${post.id}`);
    await expect(body(second)).toHaveText("Typed in the first tab");
    await expect(second.getByText("hadn't reached the server")).toBeVisible();
  });

  test("even where the browser can't tell which tabs are open, they can't overwrite each other", async ({
    page,
    signedIn,
    context,
  }) => {
    // How it is on a plain http address, where this browser feature isn't available.
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "locks", { value: undefined });
    });
    const post = await createEntry(page, signedIn, { title: "Draft", body: "On the server" });
    await openPost(page, signedIn, post.id);
    await failSaves(page);
    await retype(page, "Typed in the first tab");
    await expect(saveStatus(page)).toContainText("Offline", { timeout: 5000 });

    // It looks left behind, so the second tab offers it.
    const second = await context.newPage();
    await second.goto(`${signedIn.base}/admin/posts/${post.id}`);
    await expect(body(second)).toHaveText("Typed in the first tab");

    // The first tab gets through, and carries on.
    await page.unroute(SAVE_PATH);
    await page.keyboard.type(" and more");
    await expect(saveStatus(page)).toHaveText("Saved", { timeout: 10_000 });

    await second.getByRole("button", { name: "Keep these changes" }).click();
    await expect(second.getByText("You changed this on another device.")).toBeVisible({
      timeout: 5000,
    });
    expect(bodyText(await readEntry(page, signedIn, post.id))).toBe(
      "Typed in the first tab and more",
    );
  });

  test("two tabs offline each keep their own words", async ({ page, signedIn, context }) => {
    const post = await createEntry(page, signedIn, { title: "Draft", body: "On the server" });
    await openPost(page, signedIn, post.id);
    await failSaves(page);
    const second = await context.newPage();
    await openPost(second, signedIn, post.id);
    await failSaves(second);

    await retype(page, "First tab's words");
    await retype(second, "Second tab's words");
    await expect(saveStatus(page)).toContainText("Offline", { timeout: 5000 });
    await expect(saveStatus(second)).toContainText("Offline", { timeout: 5000 });
    await page.close();
    await second.close();

    const third = await context.newPage();
    await third.goto(`${signedIn.base}/admin/posts/${post.id}`);
    await expect(third.getByText("hadn't reached the server")).toBeVisible();
    const offered = await body(third).textContent();
    expect(["First tab's words", "Second tab's words"]).toContain(offered);
    await third.getByRole("button", { name: "Go back to the saved version" }).click();
    await third.goto(`${signedIn.base}/admin/posts/${post.id}`);
    // The other one hasn't been lost: it's offered next.
    await expect(third.getByText("hadn't reached the server")).toBeVisible();
    expect(await body(third).textContent()).not.toBe(offered);
    expect(["First tab's words", "Second tab's words"]).toContain(await body(third).textContent());
  });

  test("just opening a draft left behind and going back doesn't save it", async ({
    page,
    signedIn,
    context,
  }) => {
    const post = await createEntry(page, signedIn, { title: "Draft", body: "On the server" });
    await openPost(page, signedIn, post.id);
    await failSaves(page);
    await retype(page, "Old words left behind");
    await expect(saveStatus(page)).toContainText("Offline", { timeout: 5000 });
    await page.close();

    const again = await context.newPage();
    await again.goto(`${signedIn.base}/admin/posts/${post.id}`);
    await expect(again.getByText("hadn't reached the server")).toBeVisible();
    await again.getByRole("link", { name: "Back to posts" }).click();
    await expect(again.getByRole("heading", { name: "Posts" })).toBeVisible();
    await expect(again.getByText("haven't reached")).toBeVisible();
    expect(bodyText(await readEntry(again, signedIn, post.id))).toBe("On the server");
  });
});

test.describe("a copy on this device with nowhere to go", () => {
  test("something deleted meanwhile can still be read, kept or let go", async ({
    page,
    signedIn,
  }) => {
    const post = await createEntry(page, signedIn, { title: "Doomed" });
    await openPost(page, signedIn, post.id);
    await failSaves(page);
    await retype(page, "Words that outlive it");
    await expect(saveStatus(page)).toContainText("Offline", { timeout: 5000 });
    await postsLink(page).click();
    await page.unroute(SAVE_PATH);
    await page.request.post(`${signedIn.base}/api/admin/entries/${post.id}/trash`, { data: {} });
    await page.request.delete(`${signedIn.base}/api/admin/entries/${post.id}`, { data: {} });

    await page.getByRole("link", { name: "Open them" }).click();
    await expect(page.getByText("This has been deleted")).toBeVisible();
    await expect(page.getByText("Words that outlive it")).toBeVisible();
    await page.getByRole("button", { name: "Keep them as a new draft" }).click();
    await expect(body(page)).toHaveText("Words that outlive it");
    await expect(page.getByLabel("Title")).toHaveValue("Doomed");
    await expect(page).not.toHaveURL(new RegExp(post.id));
    await expect(saveStatus(page)).toHaveText("Saved");
    await postsLink(page).click();
    await expect(page.getByText("haven't reached")).toHaveCount(0);
  });

  test("or be thrown away, which ends the notice", async ({ page, signedIn }) => {
    const post = await createEntry(page, signedIn, { title: "Doomed" });
    await openPost(page, signedIn, post.id);
    await failSaves(page);
    await retype(page, "Not wanted");
    await expect(saveStatus(page)).toContainText("Offline", { timeout: 5000 });
    await postsLink(page).click();
    await page.request.post(`${signedIn.base}/api/admin/entries/${post.id}/trash`, { data: {} });
    await page.request.delete(`${signedIn.base}/api/admin/entries/${post.id}`, { data: {} });
    await page.getByRole("link", { name: "Open them" }).click();
    await page.getByRole("button", { name: "Throw them away" }).click();
    await expect(page.getByRole("heading", { name: "Posts" })).toBeVisible();
    await expect(page.getByText("haven't reached")).toHaveCount(0);
  });

  test("a very old copy is still offered, not deleted behind someone's back", async ({
    page,
    signedIn,
    context,
  }) => {
    const post = await createEntry(page, signedIn, { title: "Draft", body: "On the server" });
    await openPost(page, signedIn, post.id);
    await failSaves(page);
    await retype(page, "From long ago");
    await expect(saveStatus(page)).toContainText("Offline", { timeout: 5000 });
    await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve) => {
        const open = indexedDB.open("tend");
        open.onsuccess = () => resolve(open.result);
      });
      await new Promise((resolve) => {
        const store = db.transaction("drafts", "readwrite").objectStore("drafts");
        const get = store.getAll();
        get.onsuccess = () => {
          store.put({ ...get.result[0], heldAt: 0 }).onsuccess = resolve;
        };
      });
    });
    await page.close();
    const again = await context.newPage();
    await again.goto(`${signedIn.base}/admin/posts/${post.id}`);
    await expect(body(again)).toHaveText("From long ago");
  });

  test("a device refusing to store anything is told the truth", async ({ page, signedIn }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, "indexedDB", {
        value: {
          open: () => {
            throw new Error("Refused");
          },
        },
      });
    });
    const post = await createEntry(page, signedIn, { title: "Draft", body: "On the server" });
    await openPost(page, signedIn, post.id);
    await failSaves(page);
    await retype(page, "Only in memory");
    await expect(saveStatus(page)).toContainText("only in this window", { timeout: 5000 });
    await expect(saveStatus(page)).not.toContainText("kept on this device");

    await postsLink(page).click();
    await expect(page.getByText("They're only in this window")).toBeVisible();
    await expect(page.getByText("They're kept on this device")).toHaveCount(0);
    const asked = new Promise<string>((resolve) => {
      page.once("dialog", (dialog) => {
        resolve(dialog.type());
        void dialog.dismiss();
      });
    });
    await page.close({ runBeforeUnload: true });
    expect(await asked).toBe("beforeunload");
  });

  test("the same goes for being signed out on such a device", async ({ page, signedIn }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, "indexedDB", {
        value: {
          open: () => {
            throw new Error("Refused");
          },
        },
      });
    });
    const post = await createEntry(page, signedIn, { title: "Draft" });
    await openPost(page, signedIn, post.id);
    await page.context().clearCookies({ name: "tend_session" });
    await retype(page, "Only in memory");
    await expect(saveStatus(page)).toContainText("only in this window", { timeout: 5000 });
  });

  test("saved changes aren't called unsaved just because the server tidied them", async ({
    page,
    signedIn,
  }) => {
    const post = await createEntry(page, signedIn, { title: "Draft", body: "Words" });
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
    await page.getByLabel("Title").fill("Tidied   ");
    await expect(saveStatus(page)).toContainText("Offline", { timeout: 5000 });
    await page.reload();
    await expect(page.getByLabel("Title")).toHaveValue("Tidied");
    await expect(page.getByText("hadn't reached the server")).toHaveCount(0);
  });

  test("a held draft comes back too after restoring from the Trash", async ({
    page,
    signedIn,
    context,
  }) => {
    const post = await createEntry(page, signedIn, { title: "Draft", body: "On the server" });
    await openPost(page, signedIn, post.id);
    await failSaves(page);
    await retype(page, "Held words");
    await expect(saveStatus(page)).toContainText("Offline", { timeout: 5000 });
    await page.close();
    const again = await context.newPage();
    await again.request.post(`${signedIn.base}/api/admin/entries/${post.id}/trash`, { data: {} });
    await again.goto(`${signedIn.base}/admin/posts/${post.id}`);
    await expect(saveStatus(again)).toContainText("This is in the Trash");
    await again.getByRole("button", { name: "Restore" }).click();
    await expect(again.getByText("hadn't reached the server")).toBeVisible();
    await expect(saveStatus(again)).toHaveText("Not saved yet");
    await again.getByRole("button", { name: "Keep these changes" }).click();
    // The copy was made before the entry changed, so keeping it asks rather than assuming.
    await expect(again.getByText("You changed this on another device.")).toBeVisible({
      timeout: 5000,
    });
    await again.getByRole("button", { name: "Use this one" }).click();
    await expect(saveStatus(again)).toHaveText("Saved", { timeout: 5000 });
    expect(bodyText(await readEntry(again, signedIn, post.id))).toBe("Held words");
  });
});

test.describe("conflicts", () => {
  async function conflict(page: Page, site: Site) {
    const post = await createEntry(page, site, { title: "Original", body: "Original text" });
    await openPost(page, site, post.id);
    await page.request.patch(`${site.base}/api/admin/entries/${post.id}`, {
      headers: { "If-Match": String(post.rev) },
      data: { title: "Their title", doc: { type: "doc", content: [] } },
    });
    return post;
  }

  test("the status says it's waiting for a choice, and focus goes to the choice", async ({
    page,
    signedIn,
  }) => {
    await conflict(page, signedIn);
    await retype(page, "My text");
    await expect(page.getByText("You changed this on another device.")).toBeVisible({
      timeout: 5000,
    });
    await expect(saveStatus(page)).toHaveText("Not saved. Choose which version to carry on with.");
    expect((await active(page)).tag).toBe("DIV");
    expect((await active(page)).text).toContain("You changed this");
  });

  test("Use the newest doesn't lose words typed while the losing save was on its way", async ({
    page,
    signedIn,
  }) => {
    const post = await conflict(page, signedIn);
    await page.route(SAVE_PATH, async (route) => {
      if (isSave(route)) await new Promise((resolve) => setTimeout(resolve, 1200));
      await route.fallback();
    });
    await retype(page, "Sent first");
    await page.keyboard.press("ControlOrMeta+s");
    await page.keyboard.type(" and typed after", { delay: 20 });
    await expect(page.getByText("You changed this on another device.")).toBeVisible({
      timeout: 5000,
    });
    await expect(body(page)).toHaveText("Sent first and typed after");
    await page.unroute(SAVE_PATH);

    await page.getByRole("button", { name: "Use the newest version" }).click();
    await expect(page.getByLabel("Title")).toHaveValue("Their title");

    const { revisions } = await (
      await page.request.get(`${signedIn.base}/api/admin/entries/${post.id}/revisions`)
    ).json();
    const kept = await Promise.all(
      revisions.map(async (revision: { id: string }) =>
        bodyText(
          await (
            await page.request.get(`${signedIn.base}/api/admin/revisions/${revision.id}`)
          ).json(),
        ),
      ),
    );
    expect(kept).toContain("Sent first and typed after");
  });

  test("if keeping those words fails, nothing's replaced, and the choice stays", async ({
    page,
    signedIn,
  }) => {
    await conflict(page, signedIn);
    await page.route(SAVE_PATH, async (route) => {
      if (isSave(route)) await new Promise((resolve) => setTimeout(resolve, 800));
      await route.fallback();
    });
    await retype(page, "Sent first");
    await page.keyboard.press("ControlOrMeta+s");
    await page.keyboard.type(" and after");
    await expect(page.getByText("You changed this on another device.")).toBeVisible({
      timeout: 5000,
    });
    await page.unroute(SAVE_PATH);
    await failSaves(page);
    await page.getByRole("button", { name: "Use the newest version" }).click();
    await expect(page.getByText("Can't reach Tend").first()).toBeVisible();
    await expect(body(page)).toHaveText("Sent first and after");
    await expect(page.getByRole("button", { name: "Use the newest version" })).toBeVisible();
  });

  test("someone else's change names them, and says when in sensible units", async ({
    page,
    signedIn,
  }) => {
    for (const [age, wording] of [
      [10_000, "Sam Lee Jr changed this just now."],
      [3 * 60_000, "Sam Lee Jr changed this 3 minutes ago."],
      [5 * 60 * 60_000, "Sam Lee Jr changed this 5 hours ago."],
      [3 * 24 * 60 * 60_000, "Sam Lee Jr changed this 3 days ago."],
    ] as const) {
      const post = await createEntry(page, signedIn, { title: "Original", body: "Mine" });
      const current = await readEntry(page, signedIn, post.id);
      await openPost(page, signedIn, post.id);
      await page.unroute(SAVE_PATH);
      await page.route(SAVE_PATH, (route) =>
        isSave(route)
          ? route.fulfill({
              status: 409,
              contentType: "application/json",
              body: JSON.stringify({
                error: { code: "edit_conflict", message: "Changed." },
                current: {
                  ...current,
                  rev: current.rev + 1,
                  updatedAt: Date.now() - age,
                  updatedBy: { id: "someone-else", name: "Sam Lee Jr" },
                },
              }),
            })
          : route.fallback(),
      );
      await retype(page, "Changed");
      await expect(page.getByText(wording)).toBeVisible({ timeout: 5000 });
      await expect(page.getByRole("button", { name: "Use Sam Lee Jr's version" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Use mine" })).toBeVisible();
    }
  });

  test("a publish whose answer got lost isn't mistaken for someone else's", async ({
    page,
    signedIn,
  }) => {
    const post = await createEntry(page, signedIn, { title: "Hours", body: "Old", publish: true });
    await openPost(page, signedIn, post.id);
    await retype(page, "New");
    await expect(saveStatus(page)).toContainText("not on your site yet", { timeout: 5000 });
    let first = true;
    await page.route("**/publish", async (route) => {
      if (first) {
        first = false;
        await route.fetch();
        await route.abort();
        return;
      }
      await route.fallback();
    });
    await page.getByRole("button", { name: "Publish changes" }).click();
    await expect(page.getByText("Can't reach Tend").first()).toBeVisible();
    await page.getByRole("button", { name: "Publish changes" }).click();
    await expect(saveStatus(page)).toContainText("On your site");
    await expect(page.getByText("changed this")).toHaveCount(0);
  });
});

test.describe("undo", () => {
  test("Unpublish, then Undo, puts back what was live and leaves the changes pending", async ({
    page,
    signedIn,
  }) => {
    const post = await createEntry(page, signedIn, {
      title: "Prices",
      body: "Old prices",
      publish: true,
    });
    await openPost(page, signedIn, post.id);
    await retype(page, "UNREVIEWED draft words");
    await expect(saveStatus(page)).toContainText("not on your site yet", { timeout: 5000 });
    await openSettings(page);
    await page.getByRole("button", { name: "Unpublish" }).click();
    await expect(saveStatus(page)).toHaveText("Taken off your site. It's a draft now.");

    await page.locator(".fixed").getByRole("button", { name: "Undo" }).click();
    await expect(saveStatus(page)).toContainText("Changes saved, not on your site yet");
    const live = await (await page.request.get(`${signedIn.base}${post.url}`)).text();
    expect(live).toContain("Old prices");
    expect(live).not.toContain("UNREVIEWED");
    await expect(body(page)).toHaveText("UNREVIEWED draft words");
  });

  test("Undo isn't thrown away because something else is running", async ({ page, signedIn }) => {
    const post = await createEntry(page, signedIn, { title: "Short lived", publish: true });
    await openPost(page, signedIn, post.id);
    await openSettings(page);
    await page.getByRole("button", { name: "Unpublish" }).click();
    await expect(saveStatus(page)).toHaveText("Taken off your site. It's a draft now.");
    await page.route("**/api/admin/preview/*", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 800));
      await route.fallback();
    });
    await page.getByRole("button", { name: "Preview" }).click();
    await page.locator(".fixed").getByRole("button", { name: "Undo" }).click();
    await page
      .getByRole("dialog", { name: "Preview" })
      .getByRole("button", { name: "Close" })
      .click();
    await expect(saveStatus(page)).toContainText("On your site");
    expect((await page.request.get(`${signedIn.base}${post.url}`)).status()).toBe(200);
  });

  test("Discard, then Undo, brings back a changed address as well", async ({ page, signedIn }) => {
    const post = await createEntry(page, signedIn, { title: "Hours", publish: true });
    await openPost(page, signedIn, post.id);
    await openSettings(page);
    await page.getByLabel("Page address").fill("new-hours");
    await retype(page, "Changed words");
    await expect(saveStatus(page)).toContainText("not on your site yet", { timeout: 5000 });
    await page.getByRole("button", { name: "Discard changes" }).click();
    await expect(page.getByLabel("Page address")).toHaveValue("hours");
    await page.locator(".fixed").getByRole("button", { name: "Undo" }).click();
    await expect(page.getByText("Your changes are back.")).toBeVisible();
    await expect(page.getByLabel("Page address")).toHaveValue("new-hours");
    await expect(body(page)).toHaveText("Changed words");
  });

  test("Trash only mentions the site if it was on the site", async ({ page, signedIn }) => {
    const post = await createEntry(page, signedIn, { title: "Binned", publish: true });
    await page.request.post(`${signedIn.base}/api/admin/entries/${post.id}/unpublish`, {
      headers: { "If-Match": String(post.rev) },
      data: {},
    });
    await openPost(page, signedIn, post.id);
    await openSettings(page);
    await page.getByRole("button", { name: "Move to Trash" }).click();
    await expect(page.getByText("Moved to the Trash.")).toBeVisible();
    await expect(page.getByText("taken off your site")).toHaveCount(0);
  });

  test("typing can't get lost while something's being moved to the Trash", async ({
    page,
    signedIn,
  }) => {
    const post = await createEntry(page, signedIn, { title: "Binned" });
    await openPost(page, signedIn, post.id);
    await page.route("**/trash", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 600));
      await route.fallback();
    });
    await openSettings(page);
    await page.getByRole("button", { name: "Move to Trash" }).click();
    await expect(body(page)).not.toBeEditable();
    await expect(page.getByLabel("Title")).not.toBeEditable();
  });
});

test.describe("leaving, and coming straight back", () => {
  test("the offer to publish goes away, so it can't act on an older version", async ({
    page,
    signedIn,
  }) => {
    const post = await createEntry(page, signedIn, { title: "Hours", publish: true });
    await page.goto(`${signedIn.base}/admin/posts`);
    await page.getByRole("link", { name: "Hours" }).click();
    await retype(page, "First edit");
    await postsLink(page).click();
    await expect(page.getByText("Your changes aren't on your site yet.")).toBeVisible();
    await page.getByRole("link", { name: "Hours" }).click();
    await expect(body(page)).toHaveText("First edit");
    await expect(page.getByText("Your changes aren't on your site yet.")).toHaveCount(0);
    await expect(saveStatus(page)).toContainText("not on your site yet");
    expect(post.url).toBeTruthy();
  });

  test("isn't offered after signing out", async ({ page, signedIn }) => {
    const post = await createEntry(page, signedIn, { title: "Hours", publish: true });
    await openPost(page, signedIn, post.id);
    await retype(page, "Edit");
    await expect(saveStatus(page)).toContainText("not on your site yet", { timeout: 5000 });
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await page.waitForTimeout(300);
    await expect(page.getByText("aren't on your site yet")).toHaveCount(0);
  });
});

test.describe("what the editor can say about itself", () => {
  test("screen readers hear about being signed out, and about coming back", async ({
    page,
    signedIn,
  }) => {
    const post = await createEntry(page, signedIn, { title: "Draft" });
    await openPost(page, signedIn, post.id);
    await page.context().clearCookies({ name: "tend_session" });
    await retype(page, "Words");
    await expect(announcements(page)).toContainText("You've been signed out", { timeout: 5000 });
  });

  test("they hear about going offline and back online", async ({ page, signedIn }) => {
    const post = await createEntry(page, signedIn, { title: "Draft" });
    await openPost(page, signedIn, post.id);
    await failSaves(page);
    await retype(page, "Words");
    await expect(announcements(page)).toContainText("Offline", { timeout: 5000 });
    await page.unroute(SAVE_PATH);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect(announcements(page)).toHaveText("Saved", { timeout: 5000 });
  });

  test("Ctrl+S tells them how it went, including when there's nothing to save", async ({
    page,
    signedIn,
  }) => {
    const post = await createEntry(page, signedIn, { title: "Draft" });
    await openPost(page, signedIn, post.id);
    await page.keyboard.press("ControlOrMeta+s");
    await expect(announcements(page)).toHaveText("Saved");
    await retype(page, "Words");
    await page.keyboard.press("ControlOrMeta+s");
    await expect(announcements(page)).toHaveText("Saved", { timeout: 5000 });
  });

  test("publishing is announced every time, including through the review", async ({
    page,
    signedIn,
  }) => {
    const post = await createEntry(page, signedIn, { title: "Moving", publish: true });
    await openPost(page, signedIn, post.id);
    await openSettings(page);
    await page.getByLabel("Page address").fill("moved");
    await expect(saveStatus(page)).toContainText("not on your site yet", { timeout: 5000 });
    await page.getByRole("button", { name: "Publish changes" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Publish changes" }).click();
    await expect(announcements(page)).toHaveText("On your site");
  });

  test("a red error doesn't stay beside Saved", async ({ page, signedIn }) => {
    const post = await createEntry(page, signedIn, { title: "Draft", body: "Start" });
    await openPost(page, signedIn, post.id);
    await page.route(SAVE_PATH, (route) =>
      isSave(route)
        ? route.fulfill({
            status: 500,
            contentType: "application/json",
            body: JSON.stringify({ error: { code: "internal", message: "Went wrong." } }),
          })
        : route.fallback(),
    );
    await retype(page, "Changed");
    await expect(page.getByText("Went wrong.")).toBeVisible({ timeout: 5000 });
    await retype(page, "Start");
    await expect(saveStatus(page)).toHaveText("Saved", { timeout: 5000 });
    await expect(page.getByText("Went wrong.")).toHaveCount(0);
  });

  test("signing in again in another tab picks saving back up", async ({
    page,
    signedIn,
    context,
  }) => {
    const post = await createEntry(page, signedIn, { title: "Draft" });
    await openPost(page, signedIn, post.id);
    const cookies = await context.cookies();
    await context.clearCookies({ name: "tend_session" });
    await retype(page, "Written while signed out");
    await expect(saveStatus(page)).toContainText("You've been signed out", { timeout: 5000 });
    await context.addCookies(cookies);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(saveStatus(page)).toHaveText("Saved", { timeout: 5000 });
  });

  test("a failed Write another says so", async ({ page, signedIn }) => {
    const post = await createEntry(page, signedIn, { title: "First" });
    await openPost(page, signedIn, post.id);
    await page.getByRole("button", { name: "Publish post" }).click();
    await page.getByRole("button", { name: "Publish post now" }).click();
    await page.getByRole("dialog", { name: "Your post is on your site." }).waitFor();
    await page.route("**/api/admin/entries", (route) =>
      route.request().method() === "POST" ? route.abort() : route.fallback(),
    );
    await page.getByRole("button", { name: "Write another" }).click();
    await expect(page.getByRole("dialog").getByText("Can't reach Tend")).toBeVisible();
  });

  test("Copy link says whether it worked, even without the modern way to copy", async ({
    page,
    signedIn,
  }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", { value: undefined });
    });
    const post = await createEntry(page, signedIn, { title: "First" });
    await openPost(page, signedIn, post.id);
    await page.getByRole("button", { name: "Publish post" }).click();
    await page.getByRole("button", { name: "Publish post now" }).click();
    await page.getByRole("button", { name: "Copy link" }).click();
    await expect(page.getByRole("dialog").getByRole("status")).toHaveText(
      /Copied|Couldn't copy that/,
    );
    await expect(page.getByRole("button", { name: "Copy link" })).toBeVisible();
  });

  test("the hint shows the address publishing really uses", async ({ page, signedIn }) => {
    const long = await createEntry(page, signedIn, { title: "word ".repeat(40) });
    await openPost(page, signedIn, long.id);
    await openSettings(page);
    const reviewed = (await readEntry(page, signedIn, long.id)).address.path;
    await expect(page.getByText(/^This will be /)).toContainText(
      `This will be ${reviewed}. If you leave`,
    );

    const foreign = await createEntry(page, signedIn, { title: "日本語" });
    await openPost(page, signedIn, foreign.id);
    await openSettings(page);
    await expect(page.getByText(`/blog/post-${foreign.id.slice(-8)}`)).toBeVisible();
  });
});

test.describe("opening at the wrong address", () => {
  test("a page opened at a post's address moves to its own, with everything intact", async ({
    page,
    signedIn,
  }) => {
    const entry = await createEntry(page, signedIn, { type: "page", title: "Welcome", body: "" });
    await page.request.patch(`${signedIn.base}/api/admin/entries/${entry.id}`, {
      headers: { "If-Match": String(entry.rev) },
      data: {
        doc: {
          type: "doc",
          content: [
            {
              type: "section",
              attrs: { kind: "intro" },
              content: [{ type: "paragraph", content: [{ type: "text", text: "Hello" }] }],
            },
          ],
        },
      },
    });
    await page.goto(`${signedIn.base}/admin/posts/${entry.id}`);
    await expect(page).toHaveURL(new RegExp(`/admin/pages/${entry.id}`));
    await expect(body(page)).toContainText("Hello");
  });
});

test.describe("links and buttons", () => {
  test("a pasted email link survives being opened and confirmed", async ({ page, signedIn }) => {
    const post = await createEntry(page, signedIn, { title: "Links", body: "Words" });
    await openPost(page, signedIn, post.id);
    await body(page).click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("ControlOrMeta+k");
    const dialog = page.getByRole("dialog", { name: "Add a link" });
    await dialog.getByLabel(/Search your pages/).fill("hello@example.com");
    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(body(page).locator("a")).toHaveAttribute("href", "mailto:hello@example.com");
    await expect(body(page)).toBeFocused();

    await page.keyboard.press("ControlOrMeta+k");
    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(body(page).locator("a")).toHaveAttribute("href", "mailto:hello@example.com");
  });

  test("words typed and Entered look for those words, not the last list shown", async ({
    page,
    signedIn,
  }) => {
    await createEntry(page, signedIn, { type: "page", title: "Recently changed", publish: true });
    await createEntry(page, signedIn, { type: "page", title: "All about us", publish: true });
    const post = await createEntry(page, signedIn, { title: "Links", body: "Words" });
    await openPost(page, signedIn, post.id);
    await body(page).click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("ControlOrMeta+k");
    const dialog = page.getByRole("dialog", { name: "Add a link" });
    const search = dialog.getByLabel(/Search your pages/);
    await expect(dialog.getByRole("button", { name: /Links/ })).toBeVisible();
    await search.fill("nothing has this name");
    await search.press("Enter");
    await expect(dialog.getByText("That doesn't look like an address.")).toBeVisible();
    await search.fill("about us");
    await search.press("Enter");
    await expect(dialog).toHaveCount(0);
    await expect(body(page).locator("a")).toHaveAttribute("href", /^entry:/);
  });

  test("linking to something with no title writes Untitled, not an ID", async ({
    page,
    signedIn,
  }) => {
    await createEntry(page, signedIn, { type: "page", title: "", body: "Words" });
    const post = await createEntry(page, signedIn, { title: "Links", body: "" });
    await openPost(page, signedIn, post.id);
    await body(page).click();
    await page.keyboard.press("ControlOrMeta+k");
    const dialog = page.getByRole("dialog", { name: "Add a link" });
    await dialog.getByRole("button", { name: /^Untitled/ }).click();
    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(body(page).locator("a")).toHaveText("Untitled");
    await expect(body(page)).not.toContainText("entry:");
  });

  test("picking a page and pressing Change keep focus inside the dialog", async ({
    page,
    signedIn,
  }) => {
    await createEntry(page, signedIn, { type: "page", title: "About", publish: true });
    const post = await createEntry(page, signedIn, { title: "Links", body: "Words" });
    await openPost(page, signedIn, post.id);
    await body(page).click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("ControlOrMeta+k");
    const dialog = page.getByRole("dialog", { name: "Add a link" });
    await dialog.getByRole("button", { name: /^About/ }).focus();
    await page.keyboard.press("Enter");
    await expect(dialog.getByRole("status").first()).toHaveText('Goes to "About"');
    await expect(dialog.getByRole("button", { name: "Change" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(dialog.getByLabel(/Search your pages/)).toBeFocused();
  });

  test("links aren't offered inside code, or on a whole button", async ({ page, signedIn }) => {
    const post = await createEntry(page, signedIn, { title: "Code", body: "" });
    await openPost(page, signedIn, post.id);
    await body(page).click();
    await page.keyboard.type("```");
    await page.keyboard.press("Enter");
    await page.keyboard.type("some code");
    const toolbar = page.locator("fieldset");
    await expect(toolbar.getByRole("button", { name: "Link" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await expect(toolbar.getByRole("button", { name: "Bold" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await page.keyboard.press("ControlOrMeta+k");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("a selected button can be seen", async ({ page, signedIn }) => {
    const post = await createEntry(page, signedIn, { title: "Button", body: "" });
    await openPost(page, signedIn, post.id);
    await body(page).click();
    await page.keyboard.type("/button");
    await page.keyboard.press("Enter");
    await page.getByLabel("Words on the button").fill("Order");
    await page.getByRole("button", { name: "Done" }).click();
    await expect(body(page)).toBeFocused();
    // Typing carries on below the button rather than landing on it.
    await page.keyboard.type("Next line");
    await expect(body(page).locator("p").last()).toHaveText("Next line");

    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowUp");
    const selected = body(page).locator(".ProseMirror-selectednode");
    await expect(selected).toBeVisible();
    await expect(selected).toHaveCSS("outline-style", "solid");
    // The selection toolbar is for words, and a button has none to format. It takes a moment
    // to appear, so this has to give it time to.
    await page.waitForTimeout(500);
    await expect(page.getByRole("button", { name: "Underline" })).toHaveCount(0);
  });

  test("pasted markup can't make every later save fail", async ({ page, signedIn }) => {
    const entry = await createEntry(page, signedIn, { type: "page", title: "Paste", body: "" });
    await page.goto(`${signedIn.base}/admin/pages/${entry.id}`);
    await paste(
      page,
      `<a class="t-button" href="https://example.com">${"long ".repeat(100)}</a>
       <section data-tend-section kind="evil" tone="loud" align="up" preset="<b>"><p>Pasted</p></section>
       <ol start="abc"><li>One</li></ol>`,
    );
    await expect(saveStatus(page)).toHaveText("Saved", { timeout: 5000 });
    await expect(page.getByText("Tend couldn't save that content.")).toHaveCount(0);
  });

  test("pasting a table and a picture together mentions both", async ({ page, signedIn }) => {
    const post = await createEntry(page, signedIn, { title: "Paste", body: "" });
    await openPost(page, signedIn, post.id);
    await paste(page, '<table><tr><td>Cell</td></tr></table><img src="https://example.com/x.png">');
    await expect(page.getByText("A table was turned into text")).toBeVisible();
    await expect(page.getByText("Pictures can't be added yet")).toBeVisible();
  });
});

test.describe('the "/" menu and Insert', () => {
  test("names with spaces in them can be typed in full", async ({ page, signedIn }) => {
    const post = await createEntry(page, signedIn, { title: "Slash", body: "" });
    await openPost(page, signedIn, post.id);
    await body(page).click();
    await page.keyboard.type("/small h");
    await expect(page.getByRole("listbox").getByRole("option")).toHaveText(["Small heading"]);
    await page.keyboard.press("Enter");
    await expect(body(page).locator("h4")).toBeVisible();
  });

  test("words after a slash that match nothing are just writing", async ({ page, signedIn }) => {
    const post = await createEntry(page, signedIn, { title: "Slash", body: "" });
    await openPost(page, signedIn, post.id);
    await body(page).click();
    await page.keyboard.type("and /or something");
    await expect(page.getByRole("listbox")).toHaveCount(0);
    await expect(body(page)).toHaveText("and /or something");
  });

  test("it closes when focus leaves the text", async ({ page, signedIn }) => {
    const post = await createEntry(page, signedIn, { title: "Slash", body: "" });
    await openPost(page, signedIn, post.id);
    await body(page).click();
    await page.keyboard.type("/");
    await expect(page.getByRole("listbox")).toBeVisible();
    await page.getByLabel("Title").click();
    await expect(page.getByRole("listbox")).toHaveCount(0);
    await expect(body(page)).not.toHaveAttribute("aria-activedescendant", /./);
  });

  test("it stays beside the cursor when the page scrolls", async ({ page, signedIn }) => {
    const post = await createEntry(page, signedIn, { title: "Slash", body: "" });
    await openPost(page, signedIn, post.id);
    await body(page).click();
    for (let line = 0; line < 30; line++) await page.keyboard.press("Enter");
    await page.keyboard.type("/");
    const menu = page.getByRole("listbox");
    await expect(menu).toBeVisible();
    // Saving redraws everything, so this has to be after that, to see the scroll doing it.
    await expect(saveStatus(page)).toHaveText("Saved", { timeout: 5000 });
    await page.evaluate(() => window.scrollBy(0, -60));
    await page.waitForTimeout(100);
    const box = await menu.boundingBox();
    const caret = await page.evaluate(() => {
      const rect = window.getSelection()?.getRangeAt(0).getBoundingClientRect();
      return { top: rect?.top ?? 0, bottom: rect?.bottom ?? 0 };
    });
    expect(
      Math.min(
        Math.abs((box?.y ?? 0) - caret.bottom),
        Math.abs((box?.y ?? 0) + (box?.height ?? 0) - caret.top),
      ),
    ).toBeLessThan(12);
  });

  test("something that can't go where the cursor is says so", async ({ page, signedIn }) => {
    const post = await createEntry(page, signedIn, { title: "List", body: "" });
    await openPost(page, signedIn, post.id);
    await body(page).click();
    await page.keyboard.type("- ");
    await page.keyboard.type("/quote");
    await page.keyboard.press("Enter");
    await expect(page.getByText("That can't go there.")).toBeVisible();
  });

  test("a big intro from inside a list doesn't leave an empty bullet", async ({
    page,
    signedIn,
  }) => {
    const entry = await createEntry(page, signedIn, { type: "page", title: "List", body: "" });
    await page.goto(`${signedIn.base}/admin/pages/${entry.id}`);
    await body(page).click();
    await page.keyboard.type("- one");
    await page.keyboard.press("Enter");
    await page.keyboard.type("/intro");
    await page.keyboard.press("Enter");
    await expect(body(page).locator("h2")).toBeVisible();
    await expect(body(page).locator("li")).toHaveCount(1);
    await page.keyboard.type("Typed in the intro");
    await expect(body(page).locator("h2")).toHaveText("Typed in the intro");
  });

  test("Backspace below a big intro doesn't select it, ready to be typed over", async ({
    page,
    signedIn,
  }) => {
    const entry = await createEntry(page, signedIn, { type: "page", title: "Intro", body: "" });
    await page.goto(`${signedIn.base}/admin/pages/${entry.id}`);
    await body(page).click();
    await page.keyboard.type("/intro");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Important words");
    await body(page).locator("> p").last().click();
    await page.keyboard.type("Below");
    for (let letter = 0; letter < "Below".length; letter++) {
      await page.keyboard.press("ArrowLeft");
    }
    // The editor hears about the cursor moving a moment later, as it would between real keys.
    await page.waitForTimeout(100);
    await page.keyboard.press("Backspace");
    await page.keyboard.type("x");
    await expect(body(page).locator("h2")).toHaveText("Important words");
    // The words below stay below, and the cursor moved up into the section's last line.
    await expect(body(page).locator("> p").first()).toHaveText("Below");
    await expect(body(page).locator("[data-node-view-content] p").last()).toHaveText("x");
  });

  test("Delete at the edge of a big intro doesn't pull words in or out of it", async ({
    page,
    signedIn,
  }) => {
    const entry = await createEntry(page, signedIn, { type: "page", title: "Intro", body: "" });
    await page.goto(`${signedIn.base}/admin/pages/${entry.id}`);
    await body(page).click();
    await page.keyboard.type("/intro");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Heading");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.type("Inside");
    await body(page).locator("> p").last().click();
    await page.keyboard.type("Below");

    // The end of the section's last line, with words on both sides of its edge.
    const inside = body(page).locator("[data-node-view-content] p");
    await inside.click();
    await page.waitForTimeout(100);
    await page.keyboard.press("Delete");
    await page.waitForTimeout(100);
    await expect(inside).toHaveText("Inside");
    await expect(body(page).locator("> p").first()).toHaveText("Below");
    await expect(body(page).locator("h2")).toHaveText("Heading");
  });

  test("removing a big intro puts focus back in the text, and can be undone", async ({
    page,
    signedIn,
  }) => {
    const entry = await createEntry(page, signedIn, { type: "page", title: "Intro", body: "" });
    await page.goto(`${signedIn.base}/admin/pages/${entry.id}`);
    await body(page).click();
    await page.keyboard.type("/intro");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Important words");
    await page.getByRole("button", { name: "Remove" }).click();
    await expect(body(page).locator("h2")).toHaveCount(0);
    await expect(body(page)).toBeFocused();
    await page.locator(".fixed").getByRole("button", { name: "Undo" }).click();
    await expect(body(page).locator("h2")).toHaveText("Important words");
  });

  test("tabbing out of the Insert menu closes it", async ({ page, signedIn }) => {
    const post = await createEntry(page, signedIn, { title: "Insert", body: "" });
    await openPost(page, signedIn, post.id);
    await page.getByRole("button", { name: "Insert +" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("menu")).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("menu")).toHaveCount(0);
  });

  test("the selection toolbar's wrapper isn't a stop for the Tab key", async ({
    page,
    signedIn,
  }) => {
    const post = await createEntry(page, signedIn, { title: "Bubble", body: "Some words" });
    await openPost(page, signedIn, post.id);
    await body(page).click();
    await page.keyboard.press("ControlOrMeta+a");
    await expect(page.getByRole("button", { name: "Underline" })).toBeVisible();
    const stops = await page.evaluate(() => {
      const wrapper = [...document.querySelectorAll("button")].find(
        (button) => button.getAttribute("aria-label") === "Underline",
      )?.parentElement;
      return wrapper?.tabIndex;
    });
    expect(stops).toBe(-1);
  });
});

test.describe("keyboard focus", () => {
  test("isn't lost when Discard changes goes away", async ({ page, signedIn }) => {
    const post = await createEntry(page, signedIn, { title: "Hours", publish: true });
    await openPost(page, signedIn, post.id);
    await retype(page, "Changed");
    await expect(saveStatus(page)).toContainText("not on your site yet", { timeout: 5000 });
    await page.getByRole("button", { name: "Discard changes" }).focus();
    await page.keyboard.press("Enter");
    await expect(saveStatus(page)).toBeFocused();
  });

  test("isn't lost when a held draft's choice goes away", async ({ page, signedIn, context }) => {
    const post = await createEntry(page, signedIn, { title: "Draft", body: "On the server" });
    await openPost(page, signedIn, post.id);
    await failSaves(page);
    await retype(page, "Held");
    await expect(saveStatus(page)).toContainText("Offline", { timeout: 5000 });
    await page.close();
    const again = await context.newPage();
    await again.goto(`${signedIn.base}/admin/posts/${post.id}`);
    await again.getByRole("button", { name: "Go back to the saved version" }).focus();
    await again.keyboard.press("Enter");
    await expect(saveStatus(again)).toBeFocused();
  });

  test("isn't lost when Restore or Delete forever takes the row away", async ({
    page,
    signedIn,
  }) => {
    const first = await createEntry(page, signedIn, { title: "First" });
    const second = await createEntry(page, signedIn, { title: "Second" });
    for (const post of [first, second]) {
      await page.request.post(`${signedIn.base}/api/admin/entries/${post.id}/trash`, { data: {} });
    }
    await page.goto(`${signedIn.base}/admin/posts`);
    await page.getByRole("button", { name: "Trash", exact: true }).click();
    await page.getByRole("button", { name: "Restore" }).first().focus();
    await page.keyboard.press("Enter");
    // On to the row that took its place, so a long list isn't started again from the top.
    await expect(page.locator("[data-entry-row]")).toHaveCount(1);
    await expect(page.locator(":focus")).toHaveText("Restore");

    await page.getByRole("button", { name: "Delete forever" }).focus();
    await page.keyboard.press("Enter");
    await page.getByRole("dialog").getByRole("button", { name: "Delete forever" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Posts" })).toBeFocused();
  });

  test("moves between the list and the version in History on a phone", async ({
    page,
    signedIn,
  }) => {
    const post = await createEntry(page, signedIn, { title: "Post", publish: true });
    await page.setViewportSize({ width: 375, height: 700 });
    await openPost(page, signedIn, post.id);
    await page.getByRole("button", { name: "History" }).click();
    const history = page.getByRole("dialog", { name: "History" });
    const row = history.getByRole("button", { name: /Published/ });
    await row.focus();
    await page.keyboard.press("Enter");
    await expect(history.getByRole("button", { name: "Restore this version" })).toBeFocused();
    await history.getByRole("button", { name: "Back to the list" }).focus();
    await page.keyboard.press("Enter");
    await expect(row).toBeFocused();
  });

  test("can't end up hidden behind the bar at the top", async ({ page, signedIn }) => {
    const entry = await createEntry(page, signedIn, { type: "page", title: "Long", body: "" });
    await page.goto(`${signedIn.base}/admin/pages/${entry.id}`);
    await body(page).click();
    await page.keyboard.type("/intro");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Heading");
    for (let line = 0; line < 60; line++) await page.keyboard.press("Enter");
    const remove = page.getByRole("button", { name: "Remove" });
    // Scrolled so it's on the screen, but where the bar would cover it.
    await remove.evaluate((element) => {
      window.scrollBy(0, element.getBoundingClientRect().top - 40);
    });
    await remove.focus();
    const { barBottom, top } = await remove.evaluate((element) => ({
      barBottom: document.querySelector(".tend-sticky")?.getBoundingClientRect().bottom ?? 0,
      top: element.getBoundingClientRect().top,
    }));
    expect(top).toBeGreaterThanOrEqual(barBottom);
  });

  test("the pressed and highlighted states can be seen", async ({ page, signedIn }) => {
    const post = await createEntry(page, signedIn, { title: "Bold", body: "" });
    await openPost(page, signedIn, post.id);
    await body(page).click();
    await page.keyboard.type("/");
    const option = page.getByRole("option", { name: "Heading", exact: true });
    await expect(option).toHaveCSS("background-color", "rgb(29, 36, 32)");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Backspace");
    await page.locator("fieldset").getByRole("button", { name: "Bold" }).click();
    await expect(page.locator("fieldset").getByRole("button", { name: "Bold" })).toHaveCSS(
      "background-color",
      "rgb(29, 36, 32)",
    );
  });
});
