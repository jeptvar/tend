import { expect, GREETING, OWNER, test } from "./fixtures.ts";

test("from the printed link to a published site, as a new owner", async ({ page, site }) => {
  await page.goto(site.link);
  await expect(page.getByRole("heading", { name: "Welcome to Tend" })).toBeVisible();
  await expect(page).not.toHaveURL(/code=/);

  await page.getByRole("link", { name: /Start a new site/ }).click();
  await page.getByLabel("Site name").fill("Rise Bakery");
  await page.getByRole("button", { name: "Continue" }).click();

  await page.getByLabel("Your name").fill(OWNER.name);
  await page.getByLabel("Email").fill(OWNER.email);
  await page.getByLabel("Password", { exact: true }).fill(OWNER.password);
  await page.getByRole("button", { name: "Continue" }).click();

  await page.getByRole("radio", { name: /Business/ }).check();
  await page.getByRole("button", { name: "Finish setup" }).click();

  // The Owner's recovery kit comes first, shown this once (J7).
  await expect(page.getByRole("heading", { name: "Save your recovery kit" })).toBeVisible();
  await expect(
    page.getByRole("list", { name: "Your recovery codes" }).getByRole("listitem"),
  ).toHaveCount(8);
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByRole("heading", { name: GREETING })).toBeVisible();
  await expect(page.getByRole("link", { name: "Edit homepage" })).toBeVisible();

  const visitor = await page.context().newPage();
  await visitor.goto(`${site.base}/`);
  await expect(visitor.getByRole("heading", { name: "Rise Bakery", level: 1 })).toBeVisible();
  await expect(visitor.getByRole("link", { name: "Contact" })).toBeVisible();
});

test("a password only the server can refuse brings you back to the right field", async ({
  page,
  site,
}) => {
  await page.goto(site.link);
  await page.getByRole("link", { name: /Start a new site/ }).click();
  await page.getByLabel("Site name").fill("Rise Bakery");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Your name").fill(OWNER.name);
  await page.getByLabel("Email").fill(OWNER.email);
  await page.getByLabel("Password", { exact: true }).fill("password1234");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("radio", { name: /Business/ }).check();
  await page.getByRole("button", { name: "Finish setup" }).click();

  await expect(page.getByText("too easy to guess")).toBeVisible();
  await expect(page.getByLabel("Password", { exact: true })).toBeFocused();
  await expect(page.getByLabel("Your name")).toHaveValue(OWNER.name);

  await page.getByRole("button", { name: "Suggest a passphrase" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("radio", { name: /Business/ })).toBeChecked();
});

test("going back keeps what was typed on each step", async ({ page, site }) => {
  await page.goto(site.link);
  await page.getByRole("link", { name: /Start a new site/ }).click();
  await page.getByLabel("Site name").fill("Rise Bakery");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Your name").fill(OWNER.name);
  await page.getByRole("link", { name: "Back" }).click();
  await expect(page.getByLabel("Site name")).toHaveValue("Rise Bakery");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByLabel("Your name")).toHaveValue(OWNER.name);
});

test("a wrong code is explained, and can be corrected", async ({ page, site }) => {
  await page.goto(`${site.base}/admin/setup`);
  await page.getByLabel("Setup code").fill("WRONG-CODE");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText("That setup code doesn't match.")).toBeVisible();
  await page.getByLabel("Setup code").fill(site.code);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Welcome to Tend" })).toBeVisible();
});

test("signing in and out, with a wrong password in between", async ({ page, signedIn }) => {
  await page.goto(`${signedIn.base}/admin/`);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();

  await page.getByLabel("Email").fill(OWNER.email);
  await page.getByLabel("Password", { exact: true }).fill("not-the-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("That email and password don't match.")).toBeVisible();
  await expect(page.getByLabel("Password", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("Email")).toHaveValue(OWNER.email);

  await page.getByLabel("Password", { exact: true }).fill(OWNER.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("link", { name: "Edit homepage" })).toBeVisible();
});
