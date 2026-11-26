import type { Browser, Page } from "@playwright/test";
import { expect, GREETING, OWNER, type Site, test } from "./fixtures.ts";

// People and invites (PLAN.md J5), and getting back in without the old password (J7).

const NEW_PASSWORD = "harbor-violet-pencil-meadow-sky";
const ANOTHER_PASSWORD = "orchid-lantern-copper-tide-mosaic";

/** Opens a link in a browser of its own, like the person it was sent to. */
async function openAs(browser: Browser, link: string): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(link);
  return page;
}

/** Presses the button that makes a link on People, and reads the link off the screen. */
async function makeLink(page: Page, button: string, label: string): Promise<string> {
  await page.getByRole("button", { name: button }).click();
  const link = page.getByLabel(label);
  await expect(link).toBeVisible();
  return link.inputValue();
}

async function invite(page: Page, site: Site, email: string): Promise<string> {
  await page.goto(`${site.base}/admin/people`);
  await page.getByLabel("Their email").fill(email);
  await page.getByRole("radio", { name: /Editor/ }).check();
  return makeLink(page, "Make an invite link", "Invite link");
}

test("J5: the Owner invites an Editor, who joins with the link", async ({
  page,
  browser,
  signedIn,
}) => {
  const link = await invite(page, signedIn, "ed@example.com");
  expect(link).toMatch(/\/admin\/invite#[\w-]{43}$/);
  await expect(page.getByText("It works once, for 7 days.", { exact: false })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Invites waiting" })).toBeVisible();

  const invitee = await openAs(browser, link);
  await expect(invitee.getByRole("heading", { name: "Join Rise Bakery" })).toBeVisible();
  await expect(invitee.getByText("Sam Lee invited you to Rise Bakery as an Editor.")).toBeVisible();
  await expect(invitee).not.toHaveURL(/#/);
  await invitee.getByLabel("Your name").fill("Ed Ward");
  await invitee.getByRole("button", { name: "Suggest a passphrase" }).click();
  await invitee.getByRole("button", { name: "Create my account" }).click();

  // Their own recovery kit, then Overview, with an Editor's menu.
  await expect(invitee.getByRole("heading", { name: "Save your recovery kit" })).toBeVisible();
  await expect(
    invitee.getByRole("list", { name: "Your recovery codes" }).getByRole("listitem"),
  ).toHaveCount(8);
  await invitee.getByRole("button", { name: "Continue" }).click();
  await expect(invitee.getByRole("heading", { name: GREETING, level: 1 })).toBeVisible();
  await expect(invitee.getByRole("link", { name: "Pages" })).toBeVisible();
  await expect(invitee.getByRole("link", { name: "People" })).toHaveCount(0);
  await expect(invitee.getByRole("link", { name: "Settings" })).toHaveCount(0);

  // The link is used up, and the Owner sees Ed among the people.
  const again = await openAs(browser, link);
  await expect(again.getByRole("heading", { name: "This link can't be used" })).toBeVisible();
  await page.reload();
  await expect(page.getByText("Ed Ward", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Invites waiting" })).toHaveCount(0);
});

/** Sets the site up as the setup screens do, keeping the Owner's recovery kit. */
async function setUpWithKit(page: Page, site: Site): Promise<string[]> {
  const reply = await page.request.post(`${site.base}/api/auth/setup`, {
    data: {
      code: site.code,
      site: { name: "Rise Bakery", tagline: "", locale: "en", timezone: "UTC" },
      owner: OWNER,
      starter: "business",
    },
  });
  expect(reply.status()).toBe(201);
  return (await reply.json()).recoveryCodes;
}

test("J7: locked out, the Owner gets back in with a recovery code", async ({
  page,
  browser,
  site,
}) => {
  const codes = await setUpWithKit(page, site);
  const owner = await openAs(browser, `${site.base}/admin/login`);
  await owner.getByRole("link", { name: "Forgot password?" }).click();
  for (const command of ["npx tendcms", "docker compose exec tend tendcms"]) {
    await expect(owner.getByText(`${command} reset-password you@example.com`)).toBeVisible();
  }
  await owner.getByRole("link", { name: "Use a recovery code" }).click();
  // An address short enough to say over the phone leads to the same place.
  await owner.goto(`${site.base}/recover`);
  await expect(owner.getByRole("heading", { level: 1 })).toBeVisible();
  expect(new URL(owner.url()).pathname).toBe("/admin/recover");
  await owner.getByLabel("Email").fill(OWNER.email);
  await owner.getByLabel("Recovery code").fill("WRONG-CODES");
  await owner.getByRole("button", { name: "Continue" }).click();
  await expect(owner.getByText("That email and recovery code don't match.")).toBeVisible();
  await expect(owner.getByLabel("Recovery code")).toBeFocused();

  await owner.getByLabel("Recovery code").fill((codes[0] as string).toLowerCase());
  await owner.getByRole("button", { name: "Continue" }).click();
  await expect(owner.getByRole("heading", { name: "Choose a new password" })).toBeVisible();
  await expect(owner.getByText("That code is used up now. You have 7 left.")).toBeVisible();
  await owner.getByLabel("New password", { exact: true }).fill(NEW_PASSWORD);
  await owner.getByRole("button", { name: "Save new password" }).click();
  await expect(owner.getByRole("heading", { name: GREETING, level: 1 })).toBeVisible();
  await expect(owner.getByText("Your new password is saved.", { exact: false })).toBeVisible();

  // The session from before is over, and the new password works.
  await page.goto(`${site.base}/admin/`);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.getByLabel("Email").fill(OWNER.email);
  await page.getByLabel("Password", { exact: true }).fill(NEW_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("link", { name: "Edit homepage" })).toBeVisible();

  // Account says how many codes are left, and makes a new kit with the password.
  await page.getByRole("link", { name: "Account" }).click();
  await expect(page.getByText("You have 7 recovery codes left", { exact: false })).toBeVisible();
  await page.getByLabel("Your password").fill(NEW_PASSWORD);
  await page.getByRole("button", { name: "Make a new kit" }).click();
  await expect(
    page.getByRole("list", { name: "Your recovery codes" }).getByRole("listitem"),
  ).toHaveCount(8);
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByText("You have 8 recovery codes left", { exact: false })).toBeVisible();
  // Nothing says that a copy of them was kept, until one is.
  await expect(page.getByText("Tend can't tell that you kept a copy")).toBeVisible();
  await page.getByLabel("Your password").fill(NEW_PASSWORD);
  await page.getByRole("button", { name: "Make a new kit" }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download" }).click();
  expect((await download).suggestedFilename()).toBe("rise-bakery-recovery-kit.txt");
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByText("Tend can't tell that you kept a copy")).toHaveCount(0);
});

test("Account: someone changes their name, email and password, and signs out everywhere", async ({
  page,
  browser,
  signedIn,
}) => {
  const phone = await openAs(browser, `${signedIn.base}/admin/login`);
  await phone.getByLabel("Email").fill(OWNER.email);
  await phone.getByLabel("Password", { exact: true }).fill(OWNER.password);
  await phone.getByRole("button", { name: "Sign in" }).click();
  await expect(phone.getByRole("link", { name: "Overview" })).toBeVisible();

  await page.goto(`${signedIn.base}/admin/account`);
  await page.getByLabel("Your name").fill("Samira Lee");
  await page.getByRole("button", { name: "Save name" }).click();
  await expect(page.getByText("Signed in as Samira Lee")).toBeVisible();

  await page.getByText("Change your email").click();
  await page.getByLabel("New email").fill("samira@example.com");
  await page.getByRole("button", { name: "Change email" }).click();
  await expect(page.getByText("Type your password.")).toBeVisible();
  await page.getByLabel("Password, to confirm it's you").fill("not my password");
  await page.getByRole("button", { name: "Change email" }).click();
  await expect(page.getByText("That isn't your password.")).toBeVisible();
  await expect(page.getByLabel("Password, to confirm it's you")).toBeFocused();
  await page.getByLabel("Password, to confirm it's you").fill(OWNER.password);
  await page.getByRole("button", { name: "Change email" }).click();
  await expect(page.getByText("Your email is changed.", { exact: false })).toBeVisible();
  await expect(page.getByText("Change your email (samira@example.com)")).toBeVisible();

  await page.getByText("Change your password", { exact: true }).click();
  await page.getByLabel("The password you have now").fill(OWNER.password);
  await page.getByLabel("New password", { exact: true }).fill("short");
  await page.getByRole("button", { name: "Change password" }).click();
  await expect(page.getByText("Use at least 12 characters", { exact: false }).last()).toBeVisible();
  await page.getByLabel("New password", { exact: true }).fill(NEW_PASSWORD);
  await page.getByRole("button", { name: "Change password" }).click();
  await expect(page.getByText("your other devices are signed out", { exact: false })).toBeVisible();
  // This one stays signed in, and the phone doesn't.
  await page.reload();
  await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();
  await phone.reload();
  await expect(phone.getByRole("heading", { name: "Sign in" })).toBeVisible();

  await page.getByRole("button", { name: "Sign out everywhere" }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.getByLabel("Email").fill("samira@example.com");
  await page.getByLabel("Password", { exact: true }).fill(NEW_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Signed in as Samira Lee")).toBeVisible();
});

test("Account: the admin can be light or dark whatever the device is, and remembers it", async ({
  page,
  signedIn,
}) => {
  const background = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto(`${signedIn.base}/admin/account`);
  const light = await background();
  await page.emulateMedia({ colorScheme: "dark" });
  const dark = await background();
  expect(dark).not.toBe(light);

  await page.getByRole("radio", { name: "Light" }).check();
  expect(await background()).toBe(light);
  await page.reload();
  expect(await background()).toBe(light);
  await page.emulateMedia({ colorScheme: "light" });
  await page.getByRole("radio", { name: "Dark" }).check();
  expect(await background()).toBe(dark);
  await page.getByRole("radio", { name: "The same as this device" }).check();
  expect(await background()).toBe(light);
});

test("People: a role, and whether someone can sign in, are changed and taken back", async ({
  page,
  browser,
  signedIn,
}) => {
  const ed = await openAs(browser, await invite(page, signedIn, "ed@example.com"));
  await ed.getByLabel("Your name").fill("Ed Ward");
  await ed.getByLabel("Password", { exact: true }).fill(NEW_PASSWORD);
  await ed.getByRole("button", { name: "Create my account" }).click();
  await expect(ed.getByRole("heading", { name: "Save your recovery kit" })).toBeVisible();

  await page.reload();
  await page.getByLabel("What Ed Ward can do").selectOption("Admin");
  await page.getByRole("button", { name: "Change", exact: true }).click();
  await expect(
    page.getByText("Ed Ward is now an Admin, and needs to sign in again."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByText("Changed back.")).toBeVisible();
  await expect(page.getByLabel("What Ed Ward can do")).toHaveValue("editor");

  await page.getByRole("button", { name: "Stop them signing in" }).click();
  await expect(page.getByText("Ed Ward can't sign in now.")).toBeVisible();
  await expect(page.getByText("Can't sign in for now", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Make a new-password link" })).toHaveCount(0);
  await ed.goto(`${signedIn.base}/admin/login`);
  await ed.getByLabel("Email").fill("ed@example.com");
  await ed.getByLabel("Password", { exact: true }).fill(NEW_PASSWORD);
  await ed.getByRole("button", { name: "Sign in" }).click();
  await expect(
    ed.getByText("That email and password don't match.", { exact: false }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Let them sign in again" }).click();
  await expect(page.getByText("Ed Ward can sign in again.")).toBeVisible();
  await ed.getByLabel("Password", { exact: true }).fill(NEW_PASSWORD);
  await ed.getByRole("button", { name: "Sign in" }).click();
  await expect(ed.getByRole("link", { name: "Overview" })).toBeVisible();
});

test("People: the Owner hands the site over, with their password", async ({
  page,
  browser,
  signedIn,
}) => {
  const ed = await openAs(browser, await invite(page, signedIn, "ed@example.com"));
  await ed.getByLabel("Your name").fill("Ed Ward");
  await ed.getByLabel("Password", { exact: true }).fill(NEW_PASSWORD);
  await ed.getByRole("button", { name: "Create my account" }).click();
  await expect(ed.getByRole("heading", { name: "Save your recovery kit" })).toBeVisible();

  await page.reload();
  await page.getByRole("button", { name: "Make them the Owner" }).click();
  const dialog = page.getByRole("dialog", { name: "Hand the site over to Ed Ward?" });
  await expect(dialog).toContainText("You stay as an Admin");
  await dialog.getByRole("button", { name: "Make Ed Ward the Owner" }).click();
  await expect(dialog.getByText("Type your password.")).toBeVisible();
  await dialog.getByLabel("Your password").fill("not my password");
  await dialog.getByRole("button", { name: "Make Ed Ward the Owner" }).click();
  await expect(dialog.getByText("That isn't your password.", { exact: false })).toBeVisible();
  await dialog.getByLabel("Your password").fill(OWNER.password);
  await dialog.getByRole("button", { name: "Make Ed Ward the Owner" }).click();
  await expect(page.getByText("Ed Ward is the Owner now.")).toBeVisible();
  // Nothing about the Owner can be changed by whoever was.
  await expect(page.getByRole("button", { name: "Make them the Owner" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Stop them signing in" })).toHaveCount(0);

  await ed.goto(`${signedIn.base}/admin/login`);
  await ed.getByLabel("Email").fill("ed@example.com");
  await ed.getByLabel("Password", { exact: true }).fill(NEW_PASSWORD);
  await ed.getByRole("button", { name: "Sign in" }).click();
  await ed.getByRole("link", { name: "People" }).click();
  await expect(ed.getByRole("button", { name: "Make them the Owner" })).toBeVisible();
});

test("J7: the Owner sends an Editor a link to choose a new password", async ({
  page,
  browser,
  signedIn,
}) => {
  const ed = await openAs(browser, await invite(page, signedIn, "ed@example.com"));
  await ed.getByLabel("Your name").fill("Ed Ward");
  await ed.getByLabel("Password", { exact: true }).fill(NEW_PASSWORD);
  await ed.getByRole("button", { name: "Create my account" }).click();
  await expect(ed.getByRole("heading", { name: "Save your recovery kit" })).toBeVisible();

  await page.reload();
  const reset = await makeLink(page, "Make a new-password link", "Link for a new password");
  const fresh = await openAs(browser, reset);
  await expect(fresh.getByText("For ed@example.com, on Rise Bakery.")).toBeVisible();
  await fresh.getByLabel("New password", { exact: true }).fill(ANOTHER_PASSWORD);
  await fresh.getByRole("button", { name: "Save new password" }).click();
  await expect(fresh.getByRole("heading", { name: GREETING, level: 1 })).toBeVisible();

  // Ed's other session ended with the old password, which no longer works.
  await ed.goto(`${signedIn.base}/admin/`);
  await expect(ed.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await ed.getByLabel("Email").fill("ed@example.com");
  await ed.getByLabel("Password", { exact: true }).fill(NEW_PASSWORD);
  await ed.getByRole("button", { name: "Sign in" }).click();
  await expect(ed.getByText("That email and password don't match.")).toBeVisible();
  await ed.getByLabel("Password", { exact: true }).fill(ANOTHER_PASSWORD);
  await ed.getByRole("button", { name: "Sign in" }).click();
  await expect(ed.getByRole("heading", { name: GREETING, level: 1 })).toBeVisible();
});
