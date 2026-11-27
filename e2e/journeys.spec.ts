import type { Browser, Page } from "@playwright/test";
import {
  clickInto,
  createEntry,
  expect,
  GREETING,
  OWNER,
  openHistory,
  openSettings,
  photo,
  type Site,
  signIn,
  tabReachesLinks,
  test,
} from "./fixtures.ts";

// The plan's journeys (PLAN.md §6) from start to end, at the size of a computer's window and of
// a phone's screen, the way a person goes through them: no addresses typed that they wouldn't
// type, with how many presses each takes, and how long a computer takes at it.

const SIZES = [
  { name: "a computer", width: 1280, height: 800 },
  { name: "a phone", width: 375, height: 812 },
] as const;

/** J1's limit for a computer going through it (P4). The others take far less of a person. */
const J1_MS = 120_000;
const JOURNEY_MS = 60_000;

const NEW_PASSWORD = "harbor-violet-pencil-meadow-sky";

const body = (page: Page) => page.getByRole("textbox", { name: "Text" });
const saveStatus = (page: Page) => page.getByTestId("save-status");

/** Counts every press of a mouse button or a finger, in every tab, until it's read. */
async function countPresses(page: Page): Promise<() => number> {
  let presses = 0;
  await page.context().exposeBinding("tendPressed", () => {
    presses++;
  });
  await page.context().addInitScript(() => {
    addEventListener(
      "pointerdown",
      (event) => {
        if (event.isTrusted) (window as unknown as { tendPressed: () => void }).tendPressed();
      },
      { capture: true },
    );
  });
  return () => presses;
}

/** A screen of the admin, from the menu: at the side, or behind its button on a phone. */
async function goTo(page: Page, name: string): Promise<void> {
  if ((page.viewportSize()?.width ?? 0) >= 1024) {
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name, exact: true })
      .click();
    return;
  }
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  await page.getByRole("dialog", { name: "Menu" }).getByRole("link", { name, exact: true }).click();
}

/** The site, from the admin's link to it, which opens it in a tab of its own. */
async function viewSite(page: Page): Promise<Page> {
  const opened = page.waitForEvent("popup");
  if ((page.viewportSize()?.width ?? 0) >= 1024) {
    await page.getByRole("link", { name: "View site", exact: true }).click();
  } else {
    await page.getByRole("button", { name: "Menu", exact: true }).click();
    await page
      .getByRole("dialog", { name: "Menu" })
      .getByRole("link", { name: "View site", exact: true })
      .click();
  }
  return opened;
}

/** Someone else's browser, the size of the first one's. */
async function anotherPerson(browser: Browser, page: Page): Promise<Page> {
  const context = await browser.newContext({ viewport: page.viewportSize() });
  return context.newPage();
}

async function visit(page: Page, url: string): Promise<string> {
  return (await page.request.get(url)).text();
}

for (const size of SIZES) {
  test.describe(`on ${size.name}`, () => {
    test.use({ viewport: { width: size.width, height: size.height } });
    test.describe.configure({ timeout: JOURNEY_MS });

    test("J1: from the printed link to a page the Owner edited", async ({ page, site }) => {
      test.setTimeout(J1_MS);
      const presses = await countPresses(page);
      const began = Date.now();
      await page.goto(site.link);
      await page.getByRole("link", { name: /Start a new site/ }).click();
      await page.getByLabel("Site name").fill("Rise Bakery");
      await page.keyboard.press("Enter");
      await page.getByLabel("Your name").fill(OWNER.name);
      await page.getByLabel("Email").fill(OWNER.email);
      await page.getByRole("button", { name: "Suggest a passphrase" }).click();
      await page.getByRole("button", { name: "Continue" }).click();
      await page.getByRole("radio", { name: /Business/ }).check();
      await page.getByRole("button", { name: "Finish setup" }).click();
      await page.getByRole("button", { name: "Continue" }).click();

      await expect(
        page.getByText("Your site is ready on this computer. Only you can see it."),
      ).toBeVisible();
      await page.getByRole("link", { name: "Edit homepage" }).click();
      await body(page).getByRole("heading").first().click();
      await page.keyboard.press("ControlOrMeta+a");
      await page.keyboard.press("End");
      await page.keyboard.type(" Open at seven.");
      await expect(saveStatus(page)).toContainText("not on your site yet", { timeout: 10_000 });
      await page.getByRole("button", { name: "Publish changes" }).click();
      const opened = page.waitForEvent("popup");
      await page
        .getByRole("status")
        .filter({ hasText: "Published." })
        .getByRole("button", { name: "View page" })
        .click();
      const visitor = await opened;
      await expect(visitor.getByText("Open at seven.")).toBeVisible();
      expect(new URL(visitor.url()).pathname).toBe("/");
      expect(Date.now() - began).toBeLessThan(J1_MS);
      // Start, Suggest, Continue, Business, Finish, Continue, Edit, the text, Publish, View.
      expect(presses()).toBeLessThanOrEqual(12);
    });

    test("J2: a post with a photo, written, previewed and published", async ({
      page,
      signedIn,
    }) => {
      const picture = await photo(page);
      const presses = await countPresses(page);
      await page.goto(`${signedIn.base}/admin/`);
      await goTo(page, "Posts");
      await page.getByRole("button", { name: "New post" }).click();
      await expect(page.getByLabel("Title", { exact: true })).toBeFocused();
      await page.keyboard.type("Fresh loaves");
      await page.keyboard.press("Enter");
      await expect(body(page)).toBeFocused();
      await page.keyboard.type("Out of the oven at seven, every day but Monday.");
      await page.keyboard.press("Enter");

      await page.getByRole("button", { name: "Insert", exact: true }).click();
      await page.getByRole("menuitem", { name: "Image" }).click();
      await page
        .getByRole("dialog", { name: "Add an image" })
        .locator('input[type="file"]')
        .setInputFiles({ name: "loaves.jpg", mimeType: "image/jpeg", buffer: picture });
      const describe = page.getByRole("dialog", { name: "Describe this image" });
      await describe.getByLabel("Description").fill("Three loaves cooling on a rack");
      await describe.getByRole("button", { name: "Save" }).click();
      await expect(saveStatus(page)).toHaveText("Saved", { timeout: 10_000 });

      await page.getByRole("button", { name: "Preview" }).click();
      const preview = page.getByRole("dialog", { name: "Preview" });
      await expect(
        preview.frameLocator("iframe").getByRole("heading", { name: "Fresh loaves" }),
      ).toBeVisible();
      await preview.getByRole("button", { name: "Close" }).click();

      // Publish, then Publish post now, and that's all (P10).
      const before = presses();
      await page.getByRole("button", { name: "Publish post" }).click();
      const review = page.getByRole("dialog", { name: "Ready to publish?" });
      await review.getByRole("button", { name: "Publish post now" }).click();
      const done = page.getByRole("dialog", { name: "Your post is on your site." });
      await expect(done).toBeVisible();
      expect(presses() - before).toBe(2);

      const opened = page.waitForEvent("popup");
      await done.getByRole("link", { name: "View post" }).click();
      const visitor = await opened;
      await expect(visitor.getByRole("heading", { name: "Fresh loaves" })).toBeVisible();
      await expect(visitor.locator("figure.t-image img")).toHaveAttribute(
        "alt",
        "Three loaves cooling on a rack",
      );
    });

    // The plan's usability task for J2: "Change the opening hours, then check the live site."
    test("the opening hours are changed, then checked on the site", async ({
      page,
      browser,
      signedIn,
    }) => {
      const business = `${signedIn.base}/api/admin/settings/business`;
      const { value } = await (await page.request.get(business)).json();
      const week = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((day) => ({
        day,
        closed: day === "sun",
        opens: "07:00",
        closes: "17:00",
      }));
      expect((await page.request.put(business, { data: { ...value, hours: week } })).ok()).toBe(
        true,
      );
      // A customer has the homepage open already. (On this computer's address the site keeps no
      // copies of its pages, so the server's tests check that a kept one gets the new hours.)
      const customer = await anotherPerson(browser, page);
      await customer.goto(`${signedIn.base}/`);
      await expect(customer.getByRole("row", { name: /^Saturday/ })).toHaveText(
        /^Saturday\s*7:00\sAM–5:00\sPM$/,
      );
      const presses = await countPresses(page);
      await page.goto(`${signedIn.base}/admin/`);
      await goTo(page, "Settings");
      await page
        .getByRole("navigation", { name: "Settings sections" })
        .getByRole("link", { name: "Business details" })
        .click();
      await page.getByLabel("Saturday: closes").fill("14:00");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.getByText("Saved.")).toBeVisible();

      // Settings, Business details, Save and View site, and Menu twice on a phone.
      const own = await viewSite(page);
      expect(presses()).toBeLessThanOrEqual(6);
      await customer.reload();
      for (const visitor of [own, customer]) {
        // Where the homepage's Contact & hours section has them, a day to a row,
        await expect(visitor.getByRole("row", { name: /^Saturday/ })).toHaveText(
          /^Saturday\s*7:00\sAM–2:00\sPM$/,
        );
        // and at the foot of every page, with the days that are the same together.
        const footer = visitor.getByRole("contentinfo");
        await expect(footer).toContainText(/Monday – Friday: 7:00\sAM–5:00\sPM/);
        await expect(footer).toContainText(/Saturday: 7:00\sAM–2:00\sPM/);
        await expect(footer).toContainText("Sunday: Closed");
      }
    });

    test("J4: a page goes in the site menu, and where it's wanted", async ({ page, signedIn }) => {
      await createEntry(page, signedIn, { type: "page", title: "Our story", publish: true });
      // A menu of its own, so that new pages don't join it by themselves.
      await page.request.put(`${signedIn.base}/api/admin/menus/main`, {
        data: { items: [{ id: "home", label: "Home", target: { type: "home" }, children: [] }] },
      });
      const presses = await countPresses(page);
      await page.goto(`${signedIn.base}/admin/`);
      await goTo(page, "Site menu");
      await page.getByRole("button", { name: "Add link" }).click();
      const add = page.getByRole("dialog", { name: "Add a link" });
      await add.getByLabel(/Search your pages/).fill("story");
      // It moves up the list as the list is cut down to it, and people press what they can see.
      await expect(add.getByText("1 found")).toBeAttached();
      await add.getByRole("button", { name: /Our story/ }).click();
      await page.getByRole("button", { name: 'Move "Our story" up' }).click();
      await page.getByRole("button", { name: "Save menu" }).click();
      await expect(page.getByText("Menu saved.")).toBeVisible();
      expect(presses()).toBeLessThanOrEqual(6);

      const html = await visit(page, `${signedIn.base}/`);
      expect(html.indexOf(">Our story<")).toBeGreaterThan(0);
      expect(html.indexOf(">Our story<")).toBeLessThan(html.indexOf(">Home<"));
    });

    test("J5: someone is invited, joins, and publishes", async ({ page, browser, signedIn }) => {
      const presses = await countPresses(page);
      await page.goto(`${signedIn.base}/admin/`);
      await goTo(page, "People");
      await page.getByLabel("Their email").fill("ed@example.com");
      await page.getByRole("radio", { name: /Editor/ }).check();
      await page.getByRole("button", { name: "Make an invite link" }).click();
      const link = page.getByLabel("Invite link");
      await expect(link).toBeVisible();
      expect(presses()).toBeLessThanOrEqual(5);

      const invitee = await anotherPerson(browser, page);
      const theirs = await countPresses(invitee);
      await invitee.goto(await link.inputValue());
      await expect(
        invitee.getByText("Sam Lee invited you to Rise Bakery as an Editor."),
      ).toBeVisible();
      await expect(invitee.getByText("ed@example.com")).toBeVisible();
      await invitee.getByLabel("Your name").fill("Ed Ward");
      await invitee.getByRole("button", { name: "Suggest a passphrase" }).click();
      await invitee.getByRole("button", { name: "Create my account" }).click();
      await invitee.getByRole("button", { name: "Continue" }).click();
      await expect(invitee.getByRole("heading", { name: GREETING, level: 1 })).toBeVisible();
      expect(theirs()).toBeLessThanOrEqual(4);

      await goTo(invitee, "Pages");
      await invitee.getByRole("main").getByRole("button", { name: "New page" }).click();
      await expect(invitee.getByLabel("Title", { exact: true })).toBeFocused();
      await invitee.keyboard.type("Our team");
      await expect(saveStatus(invitee)).toHaveText("Saved", { timeout: 10_000 });
      await invitee.getByRole("button", { name: "Publish page" }).click();
      await invitee.getByRole("button", { name: "Publish page now" }).click();
      await expect(
        invitee.getByRole("dialog", { name: "Your page is on your site." }),
      ).toBeVisible();
      expect(await visit(page, `${signedIn.base}/our-team`)).toContain("Our team");
    });

    test("J6: half a page deleted and published is brought back", async ({ page, signedIn }) => {
      const about = await createEntry(page, signedIn, {
        type: "page",
        title: "About",
        body: "The whole story",
        publish: true,
      });
      const entries = `${signedIn.base}/api/admin/entries/${about.id}`;
      const saved = await (
        await page.request.patch(entries, {
          headers: { "If-Match": String(about.rev) },
          data: {
            doc: {
              type: "doc",
              content: [{ type: "paragraph", content: [{ type: "text", text: "Half" }] }],
            },
          },
        })
      ).json();
      const published = await page.request.post(`${entries}/publish`, {
        headers: { "If-Match": String(saved.rev) },
        data: {},
      });
      expect(published.status()).toBe(200);

      const presses = await countPresses(page);
      await page.goto(`${signedIn.base}/admin/`);
      await goTo(page, "Pages");
      await page.getByRole("link", { name: "About" }).click();
      await expect(body(page)).toHaveText("Half");
      await openHistory(page);
      const history = page.getByRole("dialog", { name: "History" });
      await history
        .getByRole("button", { name: /Published/ })
        .last()
        .click();
      await expect(history.frameLocator("iframe").getByText("The whole story")).toBeVisible();
      await history.getByRole("button", { name: "Restore this version" }).click();
      await expect(body(page)).toHaveText("The whole story");
      await page.getByRole("button", { name: "Publish changes" }).click();
      await expect(saveStatus(page)).toContainText("On your site");
      expect(presses()).toBeLessThanOrEqual(8);
      expect(await visit(page, `${signedIn.base}${about.url}`)).toContain("The whole story");
    });

    test("J6: something moved to the Trash is put back", async ({ page, signedIn }) => {
      const post = await createEntry(page, signedIn, { title: "Opening day", publish: true });
      await page.goto(`${signedIn.base}/admin/`);
      await goTo(page, "Posts");
      await page.getByRole("link", { name: "Opening day" }).click();
      await openSettings(page);
      await page.getByRole("button", { name: "Move to Trash" }).click();
      await expect(page.getByRole("heading", { name: "Posts", level: 1 })).toBeVisible();
      expect((await page.request.get(`${signedIn.base}${post.url}`)).status()).toBe(404);
      await page.getByRole("button", { name: "Undo" }).click();
      await expect(page.getByRole("link", { name: "Opening day" })).toBeVisible();
    });

    test("J7: locked out, with a recovery code and no email", async ({ page, browser, site }) => {
      const setup = await page.request.post(`${site.base}/api/auth/setup`, {
        data: {
          code: site.code,
          site: { name: "Rise Bakery", tagline: "", locale: "en", timezone: "UTC" },
          owner: OWNER,
          starter: "business",
        },
      });
      const { recoveryCodes } = await setup.json();

      const owner = await anotherPerson(browser, page);
      const presses = await countPresses(owner);
      await owner.goto(`${site.base}/admin/`);
      await owner.getByRole("link", { name: "Forgot password?" }).click();
      await owner.getByRole("link", { name: "Use a recovery code" }).click();
      await owner.getByLabel("Email").fill(OWNER.email);
      await owner.getByLabel("Recovery code").fill(recoveryCodes[0]);
      await owner.getByRole("button", { name: "Continue" }).click();
      await owner.getByLabel("New password", { exact: true }).fill(NEW_PASSWORD);
      await owner.getByRole("button", { name: "Save new password" }).click();
      await expect(owner.getByRole("heading", { name: GREETING, level: 1 })).toBeVisible();
      expect(presses()).toBeLessThanOrEqual(4);
    });

    test("J10: the site moves to a new address, with everything in it", async ({
      page,
      signedIn: old,
      newSite,
    }, testInfo) => {
      await createEntry(page, old, { title: "Opening day", body: "Come along", publish: true });
      await page.goto(`${old.base}/admin/`);
      await goTo(page, "Settings");
      await page.getByRole("link", { name: "Backups" }).click();
      const download = page.waitForEvent("download");
      await page.getByRole("link", { name: "Download backup" }).click();
      const file = testInfo.outputPath("rise-bakery-backup-PRIVATE.zip");
      await (await download).saveAs(file);

      // Another name for this computer, which the admin doesn't count as it.
      const base = newSite.base.replace("//localhost:", "//rise.localhost:");
      await page.goto(newSite.link.replace(newSite.base, base));
      await page.getByRole("link", { name: /Start from a backup/ }).click();
      await page.getByLabel("Backup file").setInputFiles(file);
      await page.getByRole("button", { name: "Restore this backup" }).click();
      await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible({
        timeout: 30_000,
      });
      await page.getByLabel("Email").fill(OWNER.email);
      await page.getByLabel("Password", { exact: true }).fill(OWNER.password);
      await page.getByRole("button", { name: "Sign in" }).click();
      const question = page.getByRole("region", { name: "Your site's address" });
      await question.getByRole("button", { name: "Use this address" }).click();
      await expect(question.getByRole("status")).toContainText("Done.");

      // Asked for at the old name, it still says the new one, and never this computer's.
      const html = await visit(page, `${newSite.base}/blog/opening-day`);
      expect(html).toContain("Come along");
      expect(html).toContain(`<link rel="canonical" href="${base}/blog/opening-day">`);
      for (const path of ["/", "/blog/opening-day", "/sitemap.xml", "/rss.xml"]) {
        const text = await visit(page, `${newSite.base}${path}`);
        expect(text.replaceAll("rise.localhost", "")).not.toContain("localhost");
      }
    });
  });
}

/** Presses Tab until something has the keyboard, the way someone without a mouse gets there. */
async function tabTo(page: Page, target: ReturnType<Page["getByRole"]>, key = "Tab") {
  await expect(target).toBeVisible();
  for (let presses = 0; presses < 80; presses++) {
    if (await target.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press(key);
  }
  throw new Error(`Tab never reached ${target}`);
}

async function signInByKeyboard(page: Page, site: Site): Promise<void> {
  // The site is set up with this browser, which is signed in from that.
  await page.context().clearCookies();
  await page.goto(`${site.base}/admin/login`);
  await tabTo(page, page.getByLabel("Email"));
  await page.keyboard.type(OWNER.email);
  await tabTo(page, page.getByLabel("Password", { exact: true }));
  await page.keyboard.type(OWNER.password);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: GREETING, level: 1 })).toBeVisible();
}

/** Opens a screen from the menu with the keyboard. */
async function goToByKeyboard(page: Page, name: string): Promise<void> {
  const link = page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name, exact: true });
  await tabTo(page, link);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();
}

test.describe("with a keyboard alone", () => {
  test.use({ viewport: { width: 1280, height: 800 } });
  test.describe.configure({ timeout: JOURNEY_MS });

  test("J2: a post with a photo is written and published", async ({ page, signedIn }) => {
    test.skip(!(await tabReachesLinks(page)), "Tab skips links in this browser");
    const picture = await photo(page);
    await signInByKeyboard(page, signedIn);
    await goToByKeyboard(page, "Posts");
    await tabTo(page, page.getByRole("button", { name: "New post" }));
    await page.keyboard.press("Enter");
    await expect(page.getByLabel("Title", { exact: true })).toBeFocused();
    await page.keyboard.type("Fresh loaves");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Out of the oven at seven.");
    await page.keyboard.press("Enter");

    await page.keyboard.type("/image");
    await expect(page.getByRole("option", { name: "Image" })).toBeVisible();
    await page.keyboard.press("Enter");
    const picker = page.getByRole("dialog", { name: "Add an image" });
    await expect(picker).toBeVisible();
    const chooser = page.waitForEvent("filechooser");
    await tabTo(page, picker.getByRole("button", { name: /Upload/ }));
    await page.keyboard.press("Enter");
    await (await chooser).setFiles({
      name: "loaves.jpg",
      mimeType: "image/jpeg",
      buffer: picture,
    });
    const describe = page.getByRole("dialog", { name: "Describe this image" });
    await expect(describe.getByLabel("Description")).toBeFocused();
    await page.keyboard.type("Three loaves");
    await tabTo(page, describe.getByRole("button", { name: "Save" }));
    await page.keyboard.press("Enter");
    await expect(describe).toBeHidden();
    await expect(saveStatus(page)).toHaveText("Saved", { timeout: 10_000 });

    await tabTo(page, page.getByRole("button", { name: "Publish post" }), "Shift+Tab");
    await page.keyboard.press("Enter");
    const review = page.getByRole("dialog", { name: "Ready to publish?" });
    await tabTo(page, review.getByRole("button", { name: "Publish post now" }));
    await page.keyboard.press("Enter");
    const done = page.getByRole("dialog", { name: "Your post is on your site." });
    await expect(done).toBeVisible();
    await tabTo(page, done.getByRole("link", { name: "View post" }));
    const opened = page.waitForEvent("popup");
    await page.keyboard.press("Enter");
    await expect((await opened).getByRole("heading", { name: "Fresh loaves" })).toBeVisible();
  });

  test("J4: a page goes in the site menu, and where it's wanted", async ({ page, signedIn }) => {
    test.skip(!(await tabReachesLinks(page)), "Tab skips links in this browser");
    await createEntry(page, signedIn, { type: "page", title: "Our story", publish: true });
    await page.request.put(`${signedIn.base}/api/admin/menus/main`, {
      data: { items: [{ id: "home", label: "Home", target: { type: "home" }, children: [] }] },
    });
    await signInByKeyboard(page, signedIn);
    await goToByKeyboard(page, "Site menu");
    await tabTo(page, page.getByRole("button", { name: "Add link" }));
    await page.keyboard.press("Enter");
    const add = page.getByRole("dialog", { name: "Add a link" });
    await expect(add.getByLabel(/Search your pages/)).toBeFocused();
    await page.keyboard.type("story");
    await tabTo(page, add.getByRole("button", { name: /Our story/ }));
    await page.keyboard.press("Enter");
    await tabTo(page, page.getByRole("button", { name: 'Move "Our story" up' }));
    await page.keyboard.press("Enter");
    await tabTo(page, page.getByRole("button", { name: "Save menu" }));
    await page.keyboard.press("Enter");
    await expect(page.getByText("Menu saved.")).toBeVisible();
    const html = await visit(page, `${signedIn.base}/`);
    expect(html.indexOf(">Our story<")).toBeGreaterThan(0);
    expect(html.indexOf(">Our story<")).toBeLessThan(html.indexOf(">Home<"));
  });

  test("J5: someone is invited, and joins", async ({ page, browser, signedIn }) => {
    test.skip(!(await tabReachesLinks(page)), "Tab skips links in this browser");
    await signInByKeyboard(page, signedIn);
    await goToByKeyboard(page, "People");
    await tabTo(page, page.getByLabel("Their email"));
    await page.keyboard.type("ed@example.com");
    await tabTo(page, page.getByRole("button", { name: "Make an invite link" }));
    await page.keyboard.press("Enter");
    const link = page.getByLabel("Invite link");
    await expect(link).toBeVisible();

    const invitee = await anotherPerson(browser, page);
    await invitee.goto(await link.inputValue());
    await tabTo(invitee, invitee.getByLabel("Your name"));
    await invitee.keyboard.type("Ed Ward");
    await tabTo(invitee, invitee.getByRole("button", { name: "Suggest a passphrase" }));
    await invitee.keyboard.press("Enter");
    await tabTo(invitee, invitee.getByRole("button", { name: "Create my account" }));
    await invitee.keyboard.press("Enter");
    await expect(invitee.getByRole("heading", { name: "Save your recovery kit" })).toBeVisible();
    await tabTo(invitee, invitee.getByRole("button", { name: "Continue" }));
    await invitee.keyboard.press("Enter");
    await expect(invitee.getByRole("heading", { name: GREETING, level: 1 })).toBeVisible();
  });
});

test("nothing is asked of anyone else's server, by the admin or the site (P7)", async ({
  page,
  signedIn,
}, testInfo) => {
  testInfo.setTimeout(JOURNEY_MS);
  const asked: string[] = [];
  const isLocal = (url: string) => url.startsWith(signedIn.base) || /^(data|blob|about):/.test(url);
  page.context().on("request", (request) => {
    if (!isLocal(request.url())) asked.push(request.url());
  });
  await page.context().route(
    (url) => !isLocal(url.href),
    (route) => route.abort(),
  );

  const picture = await photo(page);
  const post = await createEntry(page, signedIn, { title: "Fresh loaves", publish: true });
  for (const path of [
    "/admin/",
    "/admin/posts",
    "/admin/pages",
    `/admin/posts/${post.id}`,
    "/admin/media",
    "/admin/menu",
    "/admin/design",
    "/admin/people",
    "/admin/account",
    "/admin/settings/general",
    "/admin/settings/business",
    "/admin/settings/search",
    "/admin/settings/backups",
    "/admin/settings/advanced",
    "/admin/help",
    "/admin/online",
    "/admin/domain",
    "/",
    "/blog",
    "/blog/fresh-loaves",
    "/contact",
    "/not-here",
  ]) {
    await page.goto(`${signedIn.base}${path}`);
    await page.waitForLoadState("networkidle");
  }
  // Writing, with a picture, and looking at it before it's published.
  await page.goto(`${signedIn.base}/admin/posts/${post.id}`);
  await clickInto(body(page));
  await page.keyboard.press("ControlOrMeta+End");
  await page.getByRole("button", { name: "Insert", exact: true }).click();
  await page.getByRole("menuitem", { name: "Image" }).click();
  await page
    .getByRole("dialog", { name: "Add an image" })
    .locator('input[type="file"]')
    .setInputFiles({ name: "loaves.jpg", mimeType: "image/jpeg", buffer: picture });
  const describe = page.getByRole("dialog", { name: "Describe this image" });
  await describe.getByLabel("Description").fill("Loaves");
  await describe.getByRole("button", { name: "Save" }).click();
  await page.getByRole("button", { name: "Preview" }).click();
  await expect(
    page.frameLocator("iframe").getByRole("heading", { name: "Fresh loaves" }),
  ).toBeVisible();
  // Its pictures have arrived. The frame never counts as idle, because nothing in it runs.
  await expect(page.frameLocator("iframe").locator("figure.t-image img")).toBeVisible();
  await page.waitForTimeout(500);
  await page.context().clearCookies();
  for (const path of ["/admin/login", "/admin/login/forgot", "/admin/recover"]) {
    await page.goto(`${signedIn.base}${path}`);
    await page.waitForLoadState("networkidle");
  }
  expect(asked).toEqual([]);

  // Nor does a page name one, for a browser to look up or connect to ahead of time.
  for (const path of ["/admin/login", "/", "/blog/fresh-loaves", "/contact"]) {
    const html = await visit(page, `${signedIn.base}${path}`);
    const named = [...html.matchAll(/<(?:script|link|img|iframe|source)\b[^>]*>/g)]
      .map(([tag]) => tag)
      .filter((tag) => /(?:src|href|srcset)="(?:https?:)?\/\//.test(tag))
      .filter((tag) => !tag.includes(signedIn.base));
    expect(named, path).toEqual([]);
  }

  // And this would notice: something added to every page, say.
  await signIn(page, signedIn);
  const added = await page.request.put(`${signedIn.base}/api/admin/settings/code`, {
    data: { head: '<link rel="stylesheet" href="https://example.com/x.css">', bodyEnd: null },
  });
  expect(added.status()).toBe(200);
  await page.goto(`${signedIn.base}/`);
  expect(asked).toEqual(["https://example.com/x.css"]);
});
