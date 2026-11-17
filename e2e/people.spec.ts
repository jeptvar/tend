import type { Browser, Page } from "@playwright/test";
import { expect, OWNER, type Site, test } from "./fixtures.ts";

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
  await expect(invitee.getByRole("heading", { name: "Rise Bakery", level: 1 })).toBeVisible();
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
  await owner.getByRole("link", { name: "Use a recovery code" }).click();
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
  await expect(owner.getByRole("heading", { name: "Rise Bakery", level: 1 })).toBeVisible();
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
  await expect(fresh.getByRole("heading", { name: "Rise Bakery", level: 1 })).toBeVisible();

  // Ed's other session ended with the old password, which no longer works.
  await ed.goto(`${signedIn.base}/admin/`);
  await expect(ed.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await ed.getByLabel("Email").fill("ed@example.com");
  await ed.getByLabel("Password", { exact: true }).fill(NEW_PASSWORD);
  await ed.getByRole("button", { name: "Sign in" }).click();
  await expect(ed.getByText("That email and password don't match.")).toBeVisible();
  await ed.getByLabel("Password", { exact: true }).fill(ANOTHER_PASSWORD);
  await ed.getByRole("button", { name: "Sign in" }).click();
  await expect(ed.getByRole("heading", { name: "Rise Bakery", level: 1 })).toBeVisible();
});
