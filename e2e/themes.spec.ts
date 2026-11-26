import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { copyTheme, expect, test } from "./fixtures.ts";

// Themes of people's own (PLAN.md §10): started from a copy of Meadow, chosen in Design.

function edit(file: string, from: string, to: string): void {
  const before = readFileSync(file, "utf8");
  expect(before).toContain(from);
  writeFileSync(file, before.replace(from, to));
}

test("a theme of your own is previewed and chosen in Design, and Undo takes it back", async ({
  page,
  signedIn,
}) => {
  await page.goto(`${signedIn.base}/admin/design`);
  await page.getByText("Make a theme of your own").click();
  await expect(page.getByText("npx tendcms theme copy meadow my-theme")).toBeVisible();
  // With only the theme Tend comes with, there's nothing to choose between.
  await expect(page.getByRole("group", { name: "Theme" })).toHaveCount(0);

  const dir = copyTheme(signedIn);
  edit(join(dir, "partials", "footer.liquid"), "<footer", "<p>Made by us</p><footer");
  await page.reload();
  const picker = page.getByRole("group", { name: "Theme", exact: true });
  await expect(picker.getByRole("radio", { name: /^Meadow/ })).toBeChecked();
  await picker.getByRole("radio", { name: /^My theme/ }).check();

  const preview = page.getByRole("region", { name: "Preview" });
  await expect(preview.frameLocator("iframe").last().getByText("Made by us")).toBeVisible();
  // A preview changes nothing on the site.
  const visitor = await page.context().newPage();
  await visitor.goto(`${signedIn.base}/`);
  await expect(visitor.getByText("Made by us")).toHaveCount(0);

  // Its own design choices are the form's now.
  await page.getByLabel("Accent colour", { exact: true }).fill("#1d4ed8");
  await page.getByRole("button", { name: "Save design" }).click();
  const toast = page.getByText("Design saved");
  await expect(toast).toBeVisible();
  await visitor.reload();
  await expect(visitor.getByText("Made by us")).toBeVisible();
  expect(await visitor.content()).toContain("--tend-accent: #1d4ed8");

  await page.getByRole("button", { name: "Undo" }).click();
  await expect(picker.getByRole("radio", { name: /^Meadow/ })).toBeChecked();
  await visitor.reload();
  await expect(visitor.getByText("Made by us")).toHaveCount(0);
});

test("a mistake in your theme is said in Design, and visitors still get the page", async ({
  page,
  signedIn,
}) => {
  const dir = copyTheme(signedIn);
  await page.goto(`${signedIn.base}/admin/design`);
  const picker = page.getByRole("group", { name: "Theme", exact: true });
  writeFileSync(join(dir, "templates", "home.liquid"), "{{ page.title | nonsense }}");
  await picker.getByRole("radio", { name: /^My theme/ }).check();
  await expect(page.getByText(/This theme has a mistake in it: undefined filter/)).toBeVisible();
  await page.getByRole("button", { name: "Save design" }).click();
  await expect(page.getByText("Design saved")).toBeVisible();

  // On this computer the mistake is shown on the site, since whoever made it is looking.
  const visitor = await page.context().newPage();
  const reply = await visitor.goto(`${signedIn.base}/`);
  expect(reply?.status()).toBe(500);
  await expect(visitor.getByText(/undefined filter: nonsense/)).toBeVisible();
  // To anyone else, it's the page with Meadow.
  const elsewhere = signedIn.base.replace("//localhost:", "//rise.localhost:");
  expect((await visitor.goto(`${elsewhere}/`))?.status()).toBe(200);
  await expect(visitor.getByRole("heading", { level: 1 }).first()).toBeVisible();

  await page.reload();
  await expect(
    picker.getByText(/It has a mistake in it, so pages that need it use Meadow/),
  ).toBeVisible();

  writeFileSync(join(dir, "theme.json"), "");
  await page.reload();
  await expect(picker.getByText(/theme\.json:/)).toBeVisible();

  // A theme whose folder is gone leaves the site with Meadow, and Design says why.
  rmSync(dir, { recursive: true });
  expect((await visitor.goto(`${signedIn.base}/`))?.status()).toBe(200);
  await page.reload();
  await expect(page.getByText("Your theme, my-theme, can't be found")).toBeVisible();
  await picker.getByRole("radio", { name: /^Meadow/ }).check();
  await page.getByRole("button", { name: "Save design" }).click();
  await expect(page.getByText("Your theme, my-theme, can't be found")).toHaveCount(0);
});
