import type { Page, Route } from "@playwright/test";
import { bodyText, createEntry, expect, readEntry, type Site, signIn, test } from "./fixtures.ts";

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

async function openPost(page: Page, site: Site, id: string): Promise<void> {
  await page.goto(`${site.base}/admin/posts/${id}`);
  await expect(page.getByLabel("Text")).toBeVisible();
}

const postsLink = (page: Page) => page.getByRole("link", { name: "Posts", exact: true });

test.describe("writing", () => {
  test("write, publish and view a post, starting from the overview", async ({ page, signedIn }) => {
    await page.goto(`${signedIn.base}/admin/`);
    await page.getByRole("button", { name: "Write a post" }).click();

    await expect(page.getByLabel("Title")).toBeFocused();
    await page.getByLabel("Title").fill("Sourdough is back");
    await expect(page.getByText("This will be /blog/sourdough-is-back.")).toBeVisible();
    await page.getByLabel("Text").fill("We bake on Saturday.\n\nCome early <b>please</b>.");
    await expect(page.getByRole("status")).toHaveText("Not saved yet");

    await page.getByRole("button", { name: "Publish post" }).click();
    await expect(page.getByRole("status")).toContainText("On your site");

    const visitor = await page.context().newPage();
    await visitor.goto(`${signedIn.base}/blog/sourdough-is-back`);
    await expect(visitor.getByRole("heading", { name: "Sourdough is back" })).toBeVisible();
    await expect(visitor.getByText("Come early <b>please</b>.")).toBeVisible();
    await visitor.goto(`${signedIn.base}/`);
    await expect(visitor.getByRole("link", { name: "Blog" })).toBeVisible();
  });

  test("changes stay off the site until published, and the wording says so", async ({
    page,
    signedIn,
  }) => {
    const post = await createEntry(page, signedIn, { title: "Hours", publish: true });
    await openPost(page, signedIn, post.id);
    await expect(page.getByRole("status")).toContainText("On your site");

    await page.getByLabel("Text").fill("Closed on Monday");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("Changes saved, not on your site yet");
    expect(await (await page.request.get(`${signedIn.base}${post.url}`)).text()).not.toContain(
      "Closed on Monday",
    );

    await page.getByRole("button", { name: "Publish changes" }).click();
    await expect(page.getByRole("status")).toContainText("On your site");
    expect(await (await page.request.get(`${signedIn.base}${post.url}`)).text()).toContain(
      "Closed on Monday",
    );
  });

  test("the homepage can be edited, and has no address or Trash", async ({ page, signedIn }) => {
    await page.goto(`${signedIn.base}/admin/`);
    await page.getByRole("link", { name: "Edit homepage" }).click();
    await expect(page.getByLabel("Text")).toBeVisible();
    await expect(page.getByLabel("Page address")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Move to Trash" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Unpublish" })).toHaveCount(0);
  });

  test("a suggested address can be typed exactly as suggested", async ({ page, signedIn }) => {
    await createEntry(page, signedIn, { title: "Same", publish: true });
    const second = await createEntry(page, signedIn, { title: "Same" });
    await openPost(page, signedIn, second.id);

    await page.getByRole("button", { name: "Publish post" }).click();
    await expect(page.getByText("Try same-2.")).toBeVisible();
    await expect(page.getByLabel("Page address")).toBeFocused();

    await page.getByLabel("Page address").fill("/blog/same-2");
    await expect(page.getByText("This will be /blog/same-2.")).toBeVisible();
    await page.getByRole("button", { name: "Publish post" }).click();
    await expect(page.getByRole("status")).toContainText("On your site");
    expect((await page.request.get(`${signedIn.base}/blog/same-2`)).status()).toBe(200);
  });
});

test.describe("never losing what's typed", () => {
  test("typing while a save is running isn't overwritten by its answer", async ({
    page,
    signedIn,
  }) => {
    const post = await createEntry(page, signedIn, { title: "Draft", body: "" });
    await openPost(page, signedIn, post.id);
    await slowSaves(page, 500);

    const text = page.getByLabel("Text");
    await text.fill("First part");
    const answered = page.waitForResponse((response) => response.request().method() === "PATCH");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("Saving…");
    await text.pressSequentially(" and more", { delay: 10 });
    await answered;

    await expect(text).toHaveValue("First part and more");
    await expect(page.getByRole("status")).toHaveText("Not saved yet");
  });

  test("typing during a publish isn't overwritten either", async ({ page, signedIn }) => {
    const post = await createEntry(page, signedIn, { title: "Draft", body: "Live words" });
    await openPost(page, signedIn, post.id);
    await page.route("**/publish", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      await route.fallback();
    });
    const answered = page.waitForResponse((response) => response.url().endsWith("/publish"));
    await page.getByRole("button", { name: "Publish post" }).click();
    await page.getByLabel("Text").pressSequentially(" fixed a typo", { delay: 10 });
    await answered;

    await expect(page.getByLabel("Text")).toHaveValue(/fixed a typo/);
    await expect(page.getByRole("status")).toHaveText("Not saved yet");
  });

  test("leaving the editor saves what's typed", async ({ page, signedIn }) => {
    const post = await createEntry(page, signedIn, { title: "Draft" });
    await openPost(page, signedIn, post.id);
    await page.getByLabel("Text").fill("Typed then left");
    await postsLink(page).click();
    await expect(page.getByRole("heading", { name: "Posts" })).toBeVisible();
    await expect
      .poll(async () => bodyText(await readEntry(page, signedIn, post.id)))
      .toBe("Typed then left");
    await expect(page.getByText("haven't been saved")).toHaveCount(0);
  });

  test("if that save fails, the text is kept and the admin says where it is", async ({
    page,
    signedIn,
  }) => {
    const post = await createEntry(page, signedIn, { title: "Draft" });
    await openPost(page, signedIn, post.id);
    await failSaves(page);
    await page.getByLabel("Text").fill("A long paragraph typed on the bus");
    await postsLink(page).click();

    await expect(page.getByText('Your changes to "Draft" haven\'t been saved')).toBeVisible();
    await page.unroute(SAVE_PATH);

    await page.getByRole("link", { name: "Open them" }).click();
    await expect(page.getByLabel("Text")).toHaveValue("A long paragraph typed on the bus");
    await expect(page.getByText("hadn't been saved yet")).toBeVisible();

    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("Saved");
    expect(bodyText(await readEntry(page, signedIn, post.id))).toBe(
      "A long paragraph typed on the bus",
    );

    await postsLink(page).click();
    await expect(page.getByText("haven't been saved")).toHaveCount(0);
  });

  test("a held draft can be thrown away on purpose", async ({ page, signedIn }) => {
    const post = await createEntry(page, signedIn, { title: "Draft", body: "On the server" });
    await openPost(page, signedIn, post.id);
    await failSaves(page);
    await page.getByLabel("Text").fill("Second thoughts");
    await postsLink(page).click();
    await page.getByRole("link", { name: "Open them" }).click();
    await page.getByRole("button", { name: "Go back to the saved version" }).click();
    await expect(page.getByLabel("Text")).toHaveValue("On the server");
    await expect(page.getByRole("status")).toHaveText("Saved");
    await postsLink(page).click();
    await expect(page.getByText("haven't been saved")).toHaveCount(0);
  });

  test("a save refused because of the address keeps the text too", async ({ page, signedIn }) => {
    const entry = await createEntry(page, signedIn, { type: "page", title: "About" });
    await page.goto(`${signedIn.base}/admin/pages/${entry.id}`);
    await page.getByLabel("Page address").fill("blog");
    await page.getByLabel("Text").fill("Words worth keeping");
    await page.getByRole("link", { name: "Pages", exact: true }).click();

    await expect(page.getByText('Your changes to "About" haven\'t been saved')).toBeVisible();
    await page.getByRole("link", { name: "Open them" }).click();
    await expect(page.getByLabel("Text")).toHaveValue("Words worth keeping");

    await page.getByLabel("Page address").fill("about-us");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("Saved");
  });

  test("a network blip doesn't replace the open editor", async ({ page, signedIn }) => {
    const post = await createEntry(page, signedIn, { title: "Draft" });
    await openPost(page, signedIn, post.id);
    await page.getByLabel("Text").fill("Mid-sentence");
    await page.route(SAVE_PATH, (route) => route.abort());
    await page.evaluate(() => {
      window.dispatchEvent(new Event("offline"));
      window.dispatchEvent(new Event("online"));
      window.dispatchEvent(new Event("focus"));
    });
    await page.waitForTimeout(400);
    await expect(page.getByLabel("Text")).toHaveValue("Mid-sentence");
    await expect(page.getByText("Can't reach Tend")).toHaveCount(0);
  });

  test("reloading with unsaved text brings it back", async ({ page, signedIn }) => {
    const post = await createEntry(page, signedIn, { title: "Draft", body: "Saved words" });
    await openPost(page, signedIn, post.id);
    await page.getByLabel("Text").fill("Unsaved words");
    await expect(page.getByRole("status")).toHaveText("Not saved yet");
    page.on("dialog", (dialog) => dialog.accept());
    await page.reload();
    await expect(page.getByLabel("Text")).toHaveValue("Unsaved words");
    await expect(page.getByText("hadn't been saved yet")).toBeVisible();
  });

  test("signing out saves first, and doesn't go ahead if it can't", async ({ page, signedIn }) => {
    const post = await createEntry(page, signedIn, { title: "Draft" });
    await openPost(page, signedIn, post.id);
    await failSaves(page);
    await page.getByLabel("Text").fill("Don't lose this");
    await page.getByRole("button", { name: "Sign out" }).click();

    await expect(page.getByText("Can't reach Tend")).toBeVisible();
    await expect(page.getByLabel("Text")).toHaveValue("Don't lose this");
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
    await page.getByLabel("Text").fill("Written before the session ended");
    await page.context().clearCookies({ name: "tend_session" });

    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("You're not signed in.")).toBeVisible();
    await expect(page.getByLabel("Text")).toHaveValue("Written before the session ended");

    await postsLink(page).click();
    await signIn(page, signedIn);
    await expect(page.getByText('Your changes to "Draft" haven\'t been saved')).toBeVisible();
    await page.getByRole("link", { name: "Open them" }).click();
    await expect(page.getByLabel("Text")).toHaveValue("Written before the session ended");
  });

  test("reopening straight after leaving shows the new text, not an old copy", async ({
    page,
    signedIn,
  }) => {
    const post = await createEntry(page, signedIn, { title: "Quick return", body: "Old text" });
    await openPost(page, signedIn, post.id);
    await slowSaves(page, 600);
    await page.getByLabel("Text").fill("New text");
    await postsLink(page).click();
    await page.getByRole("link", { name: "Quick return" }).click();

    await expect(page.getByLabel("Text")).toHaveValue("New text");
    // It really is saved, so there's nothing to warn about.
    await expect(page.getByRole("status")).toHaveText("Saved");
    await expect(page.getByText("hadn't been saved yet")).toHaveCount(0);
    await page.getByRole("button", { name: "Publish post" }).click();
    await expect(page.getByRole("status")).toContainText("On your site");
  });

  test("going Back during a publish lets it finish", async ({ page, signedIn }) => {
    const post = await createEntry(page, signedIn, { title: "Hurried" });
    await openPost(page, signedIn, post.id);
    await page.route("**/publish", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      await route.fallback();
    });
    await page.getByLabel("Text").fill("Final words");
    await page.getByRole("button", { name: "Publish post" }).click();
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
    const text = page.getByLabel("Text");
    await text.fill("Part one");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await text.pressSequentially(" and part two", { delay: 5 });
    await page.getByRole("link", { name: "Back to posts" }).click();

    await expect
      .poll(async () => bodyText(await readEntry(page, signedIn, post.id)))
      .toBe("Part one and part two");
    await expect(page.getByText("haven't been saved")).toHaveCount(0);
  });

  test("an answer lost on the way back doesn't cause a false conflict", async ({
    page,
    signedIn,
  }) => {
    const post = await createEntry(page, signedIn, { title: "Draft" });
    await openPost(page, signedIn, post.id);
    await page.getByLabel("Text").fill("Saved but unheard");
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
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Can't reach Tend")).toBeVisible();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("Saved");
    await expect(page.getByText("Someone changed this")).toHaveCount(0);
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
    await page.getByLabel("Text").fill("My text");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Someone changed this")).toBeVisible();
    return post;
  }

  test("shows the other version, and holds the fields still while choosing", async ({
    page,
    signedIn,
  }) => {
    await conflictOnScreen(page, signedIn);
    await expect(page.getByText("Their title")).toBeVisible();
    await expect(page.getByLabel("Text")).not.toBeEditable();
    await expect(page.getByLabel("Text")).toHaveValue("My text");
  });

  test("Use mine carries on with what I typed", async ({ page, signedIn }) => {
    const post = await conflictOnScreen(page, signedIn);
    await page.getByRole("button", { name: "Use mine" }).click();
    await expect(page.getByText("Someone changed this")).toHaveCount(0);
    await expect(page.getByLabel("Text")).toHaveValue("My text");
    await expect(page.getByLabel("Text")).toBeEditable();
    expect(bodyText(await readEntry(page, signedIn, post.id))).toBe("My text");
  });

  test("Use the newest version carries on with theirs", async ({ page, signedIn }) => {
    await conflictOnScreen(page, signedIn);
    await page.getByRole("button", { name: "Use the newest version" }).click();
    await expect(page.getByLabel("Title")).toHaveValue("Their title");
    await expect(page.getByLabel("Text")).toHaveValue("Original text");
    await expect(page.getByRole("status")).toHaveText("Saved");
  });
});

test.describe("taking things down", () => {
  test("Trash takes it off the site, and Undo says what happened", async ({ page, signedIn }) => {
    const post = await createEntry(page, signedIn, { title: "Binned", publish: true });
    await openPost(page, signedIn, post.id);
    await page.getByRole("button", { name: "Move to Trash" }).click();

    await expect(page.getByText("Moved to the Trash, and taken off your site.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Binned" })).toHaveCount(0);
    expect((await page.request.get(`${signedIn.base}${post.url}`)).status()).toBe(404);

    await page.getByRole("button", { name: "Undo" }).click();
    await expect(page.getByText("It's back as a draft. Publish it")).toBeVisible();
    await expect(page.getByRole("status")).toBeFocused();
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
    await page.getByRole("button", { name: "Move to Trash" }).click();
    await expect(page.getByText("Moved to the Trash")).toBeVisible();
    await expect(page.getByRole("link", { name: "Binned" })).toHaveCount(0, { timeout: 500 });
    expect(post.url).toBeTruthy();
  });

  test("a draft that was never on the site isn't said to have been", async ({ page, signedIn }) => {
    const post = await createEntry(page, signedIn, { title: "Never published" });
    await openPost(page, signedIn, post.id);
    await page.getByRole("button", { name: "Move to Trash" }).click();
    await expect(page.getByText("Moved to the Trash.")).toBeVisible();
    await expect(page.getByText("taken off your site")).toHaveCount(0);
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(page.getByRole("status")).toHaveText("It's back as a draft.");
  });

  test("the Trash tab can restore things", async ({ page, signedIn }) => {
    const post = await createEntry(page, signedIn, { title: "In the bin" });
    await page.request.post(`${signedIn.base}/api/admin/entries/${post.id}/trash`, { data: {} });
    await page.goto(`${signedIn.base}/admin/posts`);
    await page.getByRole("button", { name: "Trash", exact: true }).click();
    await page.getByRole("button", { name: "Restore" }).click();
    await expect(page.getByRole("status")).toHaveText("It's back as a draft.");
  });

  test("opening something in the Trash offers Restore rather than Publish", async ({
    page,
    signedIn,
  }) => {
    const post = await createEntry(page, signedIn, { title: "Binned" });
    await page.request.post(`${signedIn.base}/api/admin/entries/${post.id}/trash`, { data: {} });
    await openPost(page, signedIn, post.id);
    await expect(page.getByRole("status")).toContainText("This is in the Trash");
    await expect(page.getByRole("button", { name: "Publish post" })).toHaveCount(0);
    await page.getByRole("button", { name: "Restore" }).click();
    await expect(page.getByRole("button", { name: "Publish post" })).toBeVisible();
  });

  test("Unpublish says plainly what happened, and can be undone", async ({ page, signedIn }) => {
    const post = await createEntry(page, signedIn, { title: "Short lived", publish: true });
    await openPost(page, signedIn, post.id);
    await page.getByRole("button", { name: "Unpublish" }).click();
    await expect(page.getByRole("status")).toHaveText("Taken off your site. It's a draft now.");
    await expect(page.getByRole("status")).toBeFocused();
    expect((await page.request.get(`${signedIn.base}${post.url}`)).status()).toBe(404);

    await page.getByRole("button", { name: "Undo" }).click();
    await expect(page.getByRole("status")).toContainText("On your site");
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
    await expect(page.getByLabel("Title")).toBeFocused();
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

  test("the status of the just-used button doesn't drop keyboard focus", async ({
    page,
    signedIn,
  }) => {
    const post = await createEntry(page, signedIn, { title: "Draft" });
    await openPost(page, signedIn, post.id);
    await page.getByLabel("Text").fill("Changed");
    const save = page.getByRole("button", { name: "Save", exact: true });
    await save.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("status")).toHaveText("Saved");
    await expect(save).toBeFocused();
  });
});

test.describe("what the overview says", () => {
  test("a local site says only its owner can see it", async ({ page, signedIn }) => {
    await page.goto(`${signedIn.base}/admin/`);
    await expect(page.getByText("Your site is ready on this computer.")).toBeVisible();
  });
});
