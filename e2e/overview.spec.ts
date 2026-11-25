import type { Page } from "@playwright/test";
import {
  createEntry,
  expect,
  OWNER,
  type Site,
  signIn,
  tabReachesLinks,
  test,
} from "./fixtures.ts";

// Overview, finding your way around the admin, the lists, and going online (PLAN.md §6).

/** Another name for this computer, which the admin doesn't count as it: as if it were online. */
function elsewhere(site: Site): string {
  return site.base.replace("//localhost:", "//rise.localhost:");
}

async function putSetting(page: Page, site: Site, name: string, data: object) {
  const reply = await page.request.put(`${site.base}/api/admin/settings/${name}`, { data });
  expect(reply.status()).toBe(200);
}

async function edit(page: Page, site: Site, id: string, title: string) {
  const entry = await (await page.request.get(`${site.base}/api/admin/entries/${id}`)).json();
  const reply = await page.request.patch(`${site.base}/api/admin/entries/${id}`, {
    headers: { "If-Match": String(entry.rev) },
    data: { title },
  });
  expect(reply.status()).toBe(200);
}

test.describe("Overview", () => {
  test("starts with what isn't on the site yet, until it's published", async ({
    page,
    signedIn,
  }) => {
    const about = await createEntry(page, signedIn, {
      type: "page",
      title: "About us",
      publish: true,
    });
    await page.goto(`${signedIn.base}/admin/`);
    await expect(page.getByRole("heading", { name: "Rise Bakery", level: 1 })).toBeVisible();
    await expect(page.getByRole("region", { name: /on your site yet/ })).toHaveCount(0);

    await edit(page, signedIn, about.id, "About the bakery");
    await page.reload();
    const changes = page.getByRole("region", { name: "1 change isn't on your site yet" });
    await changes.getByRole("link", { name: "About the bakery" }).click();
    await page.getByRole("button", { name: "Publish changes" }).click();
    await expect(page.getByTestId("save-status")).toContainText("On your site");
    await page.getByRole("link", { name: "Overview" }).click();
    await expect(page.getByText(/published changes to/)).toBeVisible();
    await expect(changes).toHaveCount(0);
  });

  test("has a checklist that ticks itself off, and stays closed once it's closed", async ({
    page,
    signedIn,
  }) => {
    await page.goto(`${signedIn.base}/admin/`);
    const steps = page.locator("details", { has: page.getByText("Get your site ready") });
    await expect(steps).toContainText("0 of 5 done");
    await expect(steps.getByRole("link")).toHaveText([
      "Edit your homepage",
      "Add your business details: address, phone and opening hours",
      "Add your logo",
      "Save your recovery kit",
      "Put your site online",
    ]);

    await steps.getByRole("link", { name: "Edit your homepage" }).click();
    await page.getByLabel("Title", { exact: true }).fill("Fresh bread, every day");
    await page.getByRole("button", { name: "Publish changes" }).click();
    await expect(page.getByTestId("save-status")).toContainText("On your site");
    await putSetting(page, signedIn, "business", {
      address: null,
      phone: "555 0100",
      email: null,
      mapUrl: null,
      hours: null,
      hoursNote: null,
    });
    await page.getByRole("link", { name: "Overview" }).click();
    await expect(steps).toContainText("2 of 5 done");
    await expect(steps.getByText("Done: Edit your homepage")).toBeAttached();
    await expect(steps.getByRole("link", { name: "Edit your homepage" })).toHaveCount(0);

    await steps.locator("summary").click();
    await expect(steps.getByRole("link", { name: "Add your logo" })).toBeHidden();
    await page.reload();
    await expect(steps).toContainText("2 of 5 done");
    await expect(steps.getByRole("link", { name: "Add your logo" })).toBeHidden();
    await steps.locator("summary").click();
    await expect(steps.getByRole("link", { name: "Add your logo" })).toBeVisible();
  });

  test("lists drafts, with the rest of them a link away", async ({ page, signedIn }) => {
    for (let each = 1; each <= 6; each++) {
      await createEntry(page, signedIn, { title: `Draft ${each}` });
    }
    await page.goto(`${signedIn.base}/admin/`);
    const drafts = page.getByRole("region", { name: "Drafts" });
    await expect(drafts.getByRole("link", { name: /^Draft \d$/ })).toHaveCount(5);
    await expect(drafts.getByText("And 1 more.")).toBeVisible();
    await drafts.getByRole("link", { name: "All draft posts" }).click();
    await expect(page.getByRole("button", { name: "Drafts 6" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.getByRole("link", { name: /^Draft \d$/ })).toHaveCount(6);
    // Opening one and coming back finds the drafts again.
    await page.getByRole("link", { name: "Draft 3" }).click();
    await expect(page.getByLabel("Title", { exact: true })).toHaveValue("Draft 3");
    await page.goBack();
    await expect(page.getByRole("button", { name: "Drafts 6" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  test("says what has been happening, and about the server's space", async ({ page, signedIn }) => {
    await createEntry(page, signedIn, { title: "Opening day", publish: true });
    await page.goto(`${signedIn.base}/admin/`);
    const activity = page.getByRole("region", { name: "Recent activity" });
    await expect(activity).toContainText(`${OWNER.name} published Opening day`);
    const server = page.getByRole("region", { name: "Space and copies" });
    await expect(server).toContainText("used on this server");
    await expect(server).toContainText("Tend hasn't saved a copy of your site yet.");
  });

  test("only says the site is live when anyone can see it (P15)", async ({ page, signedIn }) => {
    await page.goto(`${signedIn.base}/admin/`);
    await expect(
      page.getByText("Your site is ready on this computer. Only you can see it."),
    ).toBeVisible();

    const base = elsewhere(signedIn);
    await signIn(page, { ...signedIn, base }, "/admin/login");
    await expect(page.getByText("it doesn't have a public address yet")).toBeVisible();
    await page
      .getByRole("region", { name: "Your site's address" })
      .getByRole("button", { name: "Use this address" })
      .click();
    await expect(page.getByText(`Done. Links to your site now use ${base}.`)).toBeVisible();
    // It's an address only this computer knows, so it isn't live.
    await expect(page.getByText("which only works on your own network")).toBeVisible();
    await expect(page.getByText(/is live/)).toHaveCount(0);

    // As it is at an address everyone can reach.
    const pretend = async (visibility: string) => {
      await page.unroute("**/api/auth/me");
      await page.route("**/api/auth/me", async (route) => {
        // From where this test can ask for itself, since only the browser knows the other name.
        const me = await (await page.request.get(`${signedIn.base}/api/auth/me`)).json();
        me.site = {
          ...me.site,
          address: "https://risebakery.com",
          addressIsPublic: true,
          visibility,
        };
        await route.fulfill({ json: me });
      });
      await page.reload();
      await expect(page.getByRole("heading", { name: "Rise Bakery", level: 1 })).toBeVisible();
    };
    await pretend("public");
    await expect(page.getByText("Your site is live at")).toBeVisible();
    await expect(
      page.getByRole("link", { name: "https://risebakery.com", exact: true }),
    ).toBeVisible();
    await pretend("coming_soon");
    await expect(page.getByText("see a Coming soon page")).toBeVisible();
    await expect(page.getByText(/is live/)).toHaveCount(0);
    await pretend("private");
    await expect(page.getByText("is private: only people signed in see it")).toBeVisible();
    await expect(page.getByText(/is live/)).toHaveCount(0);
    await page.getByRole("link", { name: "Change who can see it" }).click();
    await expect(page.getByRole("heading", { name: "General", level: 1 })).toBeVisible();
  });
});

test("says when pictures can't be added on this server, and who can do something about it", async ({
  page,
  signedIn,
}) => {
  const pretend = async (role?: string) => {
    await page.unroute("**/api/auth/me");
    await page.route("**/api/auth/me", async (route) => {
      const reply = await route.fetch();
      const me = await reply.json();
      const user = role ? { ...me.user, role, isOwner: false } : me.user;
      await route.fulfill({ response: reply, json: { ...me, picturesWork: false, user } });
    });
  };
  const notice = page.getByRole("region", { name: "Pictures can't be added on this server" });

  await page.goto(`${signedIn.base}/admin/media`);
  await expect(page.getByRole("heading", { name: "Media", level: 1 })).toBeVisible();
  await expect(notice).toHaveCount(0);

  await pretend();
  await page.reload();
  await expect(notice).toContainText("PDFs can still be added");
  await page.goto(`${signedIn.base}/admin/`);
  await notice.getByRole("link", { name: "Help says why, and what to do" }).click();
  await expect(page.getByRole("heading", { name: "Help", level: 1 })).toBeVisible();

  // A Writer can't put it right, so only Media tells them, and who to ask.
  await pretend("writer");
  await page.goto(`${signedIn.base}/admin/media`);
  await expect(notice).toContainText("Ask an Admin of this site to look at Help.");
  await expect(notice.getByRole("link")).toHaveCount(0);
  await page.goto(`${signedIn.base}/admin/`);
  await expect(page.getByRole("heading", { name: "Rise Bakery", level: 1 })).toBeVisible();
  await expect(notice).toHaveCount(0);
});

test.describe("finding your way around", () => {
  test("the menu can be made narrow, and stays that way on this device", async ({
    page,
    signedIn,
  }) => {
    await page.goto(`${signedIn.base}/admin/`);
    const menu = page.getByRole("navigation", { name: "Main" });
    const width = async () => (await menu.boundingBox())?.width ?? 0;
    expect(await width()).toBeGreaterThan(150);
    await page.getByRole("button", { name: "Hide names" }).click();
    expect(await width()).toBeLessThan(90);
    await page.reload();
    await expect(page.getByRole("button", { name: "Show names" })).toBeVisible();
    expect(await width()).toBeLessThan(90);
    // Its links still have their names.
    await menu.getByRole("link", { name: "Posts" }).click();
    await expect(page.getByRole("heading", { name: "Posts", level: 1 })).toBeVisible();
    await page.getByRole("button", { name: "Show names" }).click();
    expect(await width()).toBeGreaterThan(150);
  });

  test("Help is in the same place on every screen, and the menu says where you are", async ({
    page,
    signedIn,
  }) => {
    const places: string[] = [];
    for (const [name, path] of [
      ["Overview", "/admin/"],
      ["Posts", "/admin/posts"],
      ["Design", "/admin/design"],
      ["Settings", "/admin/settings/backups"],
    ] as const) {
      await page.goto(`${signedIn.base}${path}`);
      const help = page.getByRole("link", { name: "Help", exact: true });
      const box = await help.boundingBox();
      places.push(`${box?.x},${box?.y}`);
      await expect(page.getByRole("link", { name, exact: true })).toHaveAttribute(
        "aria-current",
        "page",
      );
    }
    expect(new Set(places).size).toBe(1);

    await page.getByRole("link", { name: "Help", exact: true }).click();
    await page.getByText("Get something back").click();
    await expect(page.getByText("Anything moved to the Trash can be restored")).toBeVisible();
    await page.getByText("How Tend is doing, and reporting a problem").click();
    await expect(page.getByText(/^Tend 0\./)).toContainText("Node.js");
    await expect(page.getByText(/Node\.js .* gets security fixes until/)).toBeVisible();
    await expect(page.getByRole("link", { name: /Report a problem/ })).toHaveAttribute(
      "href",
      /github\.com/,
    );
  });

  test("a keyboard can skip the menu", async ({ page, signedIn }) => {
    const byTab = await tabReachesLinks(page);
    await page.goto(`${signedIn.base}/admin/posts`);
    await expect(page.getByRole("heading", { name: "Posts", level: 1 })).toBeVisible();
    const skip = page.getByRole("link", { name: "Skip to the content" });
    if (byTab) await page.keyboard.press("Tab");
    else await skip.focus();
    await expect(skip).toBeFocused();
    await expect(skip).toBeInViewport();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "Posts", level: 1 })).toBeFocused();
    expect(new URL(page.url()).hash).toBe("");
  });

  test("an address that isn't anything says so", async ({ page, signedIn }) => {
    await page.goto(`${signedIn.base}/admin/nothing-here`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("There's nothing here");
  });
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("the bar at the bottom has what a Business site needs most", async ({ page, signedIn }) => {
    await page.goto(`${signedIn.base}/admin/`);
    const bar = page.getByRole("navigation", { name: "Most used" });
    await expect(bar.getByRole("listitem")).toHaveText(["Overview", "Pages", "New", "Media"]);
    await bar.getByRole("link", { name: "Pages" }).click();
    await expect(page.getByRole("heading", { name: "Pages", level: 1 })).toBeVisible();
    await expect(bar.getByRole("link", { name: "Pages" })).toHaveAttribute("aria-current", "page");
    await bar.getByRole("button", { name: "New page" }).click();
    await expect(page.getByLabel("Title", { exact: true })).toBeVisible();
    expect(page.url()).toContain("/admin/pages/");
    // Out of the way while writing.
    await expect(bar).toHaveCount(0);
  });

  test("the rest is behind the menu button, which gets focus back", async ({ page, signedIn }) => {
    await page.goto(`${signedIn.base}/admin/`);
    const button = page.getByRole("button", { name: "Menu", exact: true });
    await button.click();
    const menu = page.getByRole("dialog", { name: "Menu" });
    await expect(menu.getByRole("link")).toHaveText([
      "Overview",
      "Posts",
      "Pages",
      "Media",
      "Site menu",
      "Design",
      "People",
      "Settings",
      "View site",
      "Help",
      "Account",
    ]);
    await expect(menu.getByText(`Signed in as ${OWNER.name}`)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(button).toBeFocused();

    await button.click();
    await menu.getByRole("link", { name: "Design" }).click();
    await expect(page.getByRole("heading", { name: "Design", level: 1 })).toBeFocused();
    await expect(menu).toHaveCount(0);
    // Where someone is already: the menu goes, and the screen stays.
    await button.click();
    await menu.getByRole("link", { name: "Design" }).click();
    await expect(menu).toHaveCount(0);
  });

  test("nothing is hidden behind the bar: what's saved, and what it says", async ({
    page,
    signedIn,
  }) => {
    await page.goto(`${signedIn.base}/admin/design`);
    const bar = page.getByRole("navigation", { name: "Most used" });
    const save = page.getByRole("button", { name: "Save design" });
    await page.getByLabel("Footer text").fill("Open daily");
    await save.click();
    const toast = page.getByText("Design saved.");
    await expect(toast).toBeVisible();
    const top = (await bar.boundingBox())?.y ?? 0;
    for (const above of [save, toast]) {
      const box = await above.boundingBox();
      expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(top);
    }
  });
});

test("a Blog has posts in its bar on a phone", async ({ page, site }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const reply = await page.request.post(`${site.base}/api/auth/setup`, {
    data: {
      code: site.code,
      site: { name: "Crumbs", tagline: "", locale: "en", timezone: "UTC" },
      owner: OWNER,
      starter: "blog",
    },
  });
  expect(reply.status()).toBe(201);
  await page.goto(`${site.base}/admin/`);
  const bar = page.getByRole("navigation", { name: "Most used" });
  await expect(bar.getByRole("listitem")).toHaveText(["Overview", "Posts", "New", "Media"]);
  await expect(page.getByRole("button", { name: "Write your first post" })).toBeVisible();
  await bar.getByRole("button", { name: "New post" }).click();
  await expect(page.getByLabel("Title", { exact: true })).toBeVisible();
  expect(page.url()).toContain("/admin/posts/");
});

test.describe("the lists of posts and pages", () => {
  test("have a tab for each part, with how many are in it", async ({ page, signedIn }) => {
    await createEntry(page, signedIn, { title: "Winter" });
    await createEntry(page, signedIn, { title: "Summer", publish: true });
    const gone = await createEntry(page, signedIn, { title: "Gone" });
    await page.request.post(`${signedIn.base}/api/admin/entries/${gone.id}/trash`, { data: {} });
    await page.goto(`${signedIn.base}/admin/posts`);
    const rows = page.locator("[data-entry-row] a[href^='/admin/posts/']");
    await expect(rows).toHaveText(["Summer", "Winter"]);
    for (const [tab, titles] of [
      ["Drafts 1", ["Winter"]],
      ["Published 1", ["Summer"]],
      ["All 2", ["Summer", "Winter"]],
    ] as const) {
      await page.getByRole("button", { name: tab }).click();
      await expect(rows).toHaveText([...titles]);
    }
    await page.getByRole("button", { name: "Trash 1" }).click();
    await expect(page.getByText("Gone", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Restore" }).click();
    await expect(page.getByRole("button", { name: "Drafts 2" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Trash 0" })).toBeVisible();
    await expect(page.getByText("Nothing in the Trash.")).toBeVisible();
  });

  test("can be searched once they're long, and say so to a screen reader", async ({
    page,
    signedIn,
  }) => {
    await page.goto(`${signedIn.base}/admin/posts`);
    await expect(page.getByText("No posts yet.", { exact: false })).toBeVisible();
    const search = page.getByRole("searchbox", { name: "Search posts by title" });
    await expect(search).toHaveCount(0);
    for (const title of ["Crème brûlée", "Rye", "Croissants"]) {
      await createEntry(page, signedIn, { title, publish: true });
    }
    for (let each = 1; each <= 8; each++) {
      await createEntry(page, signedIn, { title: `Loaf ${each}` });
    }
    await page.reload();
    await search.fill("creme");
    const rows = page.locator("[data-entry-row] a[href^='/admin/posts/']");
    await expect(rows).toHaveText(["Crème brûlée"]);
    await expect(page.getByText("1 found", { exact: true })).toBeAttached();
    await page.getByRole("button", { name: "Drafts 8" }).click();
    await expect(page.getByText("Nothing here has “creme” in its title.")).toBeVisible();
    await search.fill("");
    await expect(rows).toHaveCount(8);
  });
});

test.describe("going online", () => {
  test("a site on this computer has the way to put it online", async ({ page, signedIn }) => {
    await page.goto(`${signedIn.base}/admin/`);
    await page.getByRole("link", { name: "Put your site online" }).click();
    await expect(page.getByRole("heading", { name: "Put your site online" })).toBeFocused();
    await expect(page.getByRole("heading", { level: 2 })).toHaveText([
      "Download a backup",
      "Put a new Tend on Railway",
      "Choose Start from a backup there",
      "Sign in, and use the new address",
    ]);
    await expect(page.getByText("$5 a month")).toBeVisible();
    const download = page.waitForEvent("download");
    await page.getByRole("link", { name: "Download backup (private)" }).click();
    expect((await download).suggestedFilename()).toMatch(/PRIVATE/);

    await page.goto(`${signedIn.base}/admin/domain`);
    await expect(page.getByText("has to be online before it can have a domain")).toBeVisible();
    await page.goto(`${signedIn.base}/admin/settings/general`);
    await expect(
      page.getByRole("region", { name: "Site address" }).getByRole("link", {
        name: "Put your site online",
      }),
    ).toBeVisible();
  });

  test("the site's address can be chosen from Settings, where it's open", async ({
    page,
    signedIn,
  }) => {
    const base = elsewhere(signedIn);
    await signIn(page, { ...signedIn, base }, "/admin/login");
    await page.goto(`${base}/admin/settings/general`);
    const address = page.getByRole("region", { name: "Site address" });
    await expect(address).toContainText("doesn't have an address of its own yet");
    await address.getByRole("button", { name: `Use ${base}` }).click();
    await expect(address).toContainText(`use ${base}. Someone chose it here.`);
    await expect(address.getByRole("status")).toBeFocused();
    await expect(address.getByRole("button")).toHaveCount(0);
    await address.getByRole("link", { name: "Connect your domain" }).click();
    await expect(page.getByRole("heading", { name: "Connect your domain" })).toBeFocused();
    await expect(page.getByText("MX and TXT records")).toBeVisible();
  });

  test("plain http to another computer gets a warning, before any password is typed", async ({
    page,
    signedIn,
  }) => {
    const warning = page.getByRole("region", { name: "This connection isn't private" });
    await page.goto(`${signedIn.base}/admin/`);
    await expect(page.getByRole("heading", { name: "Rise Bakery", level: 1 })).toBeVisible();
    await expect(warning).toHaveCount(0);
    await page.goto(`${elsewhere(signedIn)}/admin/login`);
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await expect(warning).toContainText("your password included");
  });

  test("the site's language is chosen in Settings, and its pages say so", async ({
    page,
    signedIn,
  }) => {
    await page.goto(`${signedIn.base}/admin/settings/general`);
    await page.getByLabel("Language").selectOption({ label: "French (français)" });
    await page.getByRole("button", { name: "Save", exact: true }).first().click();
    await expect(page.getByText("Saved.")).toBeVisible();
    await page.goto(`${signedIn.base}/`);
    expect(await page.locator("html").getAttribute("lang")).toBe("fr");
  });
});
