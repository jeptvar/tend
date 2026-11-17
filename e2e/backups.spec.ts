import { readFileSync } from "node:fs";
import { expect, test } from "./fixtures.ts";

// Backups (PLAN.md §13, J10): the whole site, downloaded from Settings → Backups.

test("the Owner downloads the whole site from Settings, as a private zip", async ({
  page,
  signedIn,
}) => {
  await page.goto(`${signedIn.base}/admin/settings/backups`);
  await expect(page.getByRole("heading", { name: "Download a backup" })).toBeVisible();
  await expect(page.getByText("No backup has been downloaded yet.")).toBeVisible();
  await expect(page.getByText(/^Keep this file private/)).toBeVisible();

  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download backup (private)" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^rise-bakery-backup-PRIVATE-\d{4}-\d{2}-\d{2}\.zip$/);
  expect(
    readFileSync(await file.path())
      .subarray(0, 2)
      .toString(),
  ).toBe("PK");

  // It counts once the last of it has arrived, and the page says so when next opened.
  await expect
    .poll(async () => {
      const reply = await page.request.get(`${signedIn.base}/api/admin/backups`);
      return (await reply.json()).lastDownloadAt;
    })
    .not.toBeNull();
  await page.reload();
  await expect(page.getByText(/^Last downloaded on /)).toBeVisible();
});
