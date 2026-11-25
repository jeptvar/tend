import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";

// Settings that can't be loaded or saved say so, and what to do (PLAN.md §4, P13).

/** Answers requests for this with an error, until the returned function is called. */
async function failing(page: Page, url: string, method = "GET"): Promise<() => Promise<void>> {
  await page.route(url, async (route) => {
    if (route.request().method() !== method) return route.fallback();
    await route.fulfill({
      status: 500,
      json: {
        error: {
          code: "unexpected",
          message: "Something went wrong on the server.",
          fix: "Try again.",
        },
      },
    });
  });
  return () => page.unroute(url);
}

test("an open day without a time is refused with what to do, and a closed one isn't", async ({
  page,
  signedIn,
}) => {
  await page.goto(`${signedIn.base}/admin/settings/business`);
  await page.getByRole("button", { name: "Add opening hours" }).click();
  await page.getByLabel("Monday: opens").fill("");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByText("Give each open day a time it opens and a time it closes"),
  ).toBeVisible();

  await page.getByRole("checkbox", { name: "Monday: closed" }).check();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
});

test("screens that can't load say why, and try again", async ({ page, signedIn }) => {
  for (const [path, url, loaded] of [
    ["/admin/settings/general", "**/api/admin/settings/general", "Site name"],
    ["/admin/settings/business", "**/api/admin/settings/business", "Phone"],
    ["/admin/settings/advanced", "**/api/admin/settings/code", "In the head of every page"],
    ["/admin/settings/backups", "**/api/admin/backups", "Download a backup"],
    ["/admin/design", "**/api/admin/design", "Accent colour"],
    ["/admin/menu", "**/api/admin/menus", "Add link"],
    ["/admin/people", "**/api/admin/people", "Sam Lee"],
    ["/admin/media", "**/api/admin/media?*", "table.jpg"],
    ["/admin/account", "**/api/auth/recovery-kit", "You have 8 recovery codes left"],
  ] as const) {
    const works = await failing(page, url);
    await page.goto(`${signedIn.base}${path}`);
    const again = page.getByRole("button", { name: "Try again" });
    // It's tried a few times before it's given up on.
    await expect(again, path).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("Something went wrong on the server.")).toBeVisible();
    await works();
    await again.click();
    await expect(page.getByText(loaded).first(), path).toBeVisible();
    await expect(again).toHaveCount(0);
  }
});

test("redirects that can't load aren't said to be none, and one that can't go says why", async ({
  page,
  signedIn,
}) => {
  await page.request.post(`${signedIn.base}/api/admin/redirects`, {
    data: { from: "/old", to: "/contact" },
  });
  const works = await failing(page, "**/api/admin/redirects");
  await page.goto(`${signedIn.base}/admin/settings/search`);
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("No redirects yet")).toHaveCount(0);
  await works();
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByText("/old → /contact")).toBeVisible();

  const removing = await failing(page, "**/api/admin/redirects", "DELETE");
  await page.getByRole("button", { name: "Remove the redirect from /old" }).click();
  await expect(page.getByText("Something went wrong on the server. Try again.")).toBeVisible();
  await expect(page.getByText("/old → /contact")).toBeVisible();
  await removing();
});

test("screens for Admins send an Editor to Overview, and a mistyped address says so", async ({
  page,
  browser,
  signedIn,
}) => {
  const reply = await page.request.post(`${signedIn.base}/api/admin/people/invites`, {
    data: { email: "ed@example.com", role: "editor" },
  });
  const { token } = await reply.json();
  const context = await browser.newContext();
  const editor = await context.newPage();
  await editor.goto(`${signedIn.base}/admin/invite#${token}`);
  await editor.getByLabel("Your name").fill("Ed Ward");
  await editor.getByRole("button", { name: "Suggest a passphrase" }).click();
  await editor.getByRole("button", { name: "Create my account" }).click();
  await expect(editor.getByRole("heading", { name: "Save your recovery kit" })).toBeVisible();
  for (const path of ["people", "design", "settings/general"]) {
    await editor.goto(`${signedIn.base}/admin/${path}`);
    await expect(editor.getByRole("heading", { name: "Rise Bakery", level: 1 })).toBeVisible();
    await expect(editor).toHaveURL(`${signedIn.base}/admin/`);
  }
  await context.close();

  await page.goto(`${signedIn.base}/admin/desing`);
  await expect(page.getByRole("heading", { name: "There's nothing here" })).toBeVisible();
  await page.getByRole("link", { name: "Go to Overview" }).click();
  await expect(page.getByRole("heading", { name: "Rise Bakery", level: 1 })).toBeVisible();
});
