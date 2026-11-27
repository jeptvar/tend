import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import {
  createEntry,
  expect,
  OWNER,
  pretendDataIsAtRisk,
  type Site,
  signIn,
  test,
} from "./fixtures.ts";

// Backups (PLAN.md §13, J10): the whole site, downloaded from Settings → Backups, and put back
// as it was from there (v0.2).

async function postTitles(page: Page, site: Site): Promise<string[]> {
  const reply = await page.request.get(`${site.base}/api/admin/entries?type=post`);
  return (await reply.json()).entries.map((entry: { title: string }) => entry.title);
}

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

test("a copy can be saved there and then, and downloaded by the Owner", async ({
  page,
  signedIn,
}) => {
  await page.goto(`${signedIn.base}/admin/settings/backups`);
  await expect(page.getByText("There are no copies yet.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Save a copy now" }).click();
  await expect(page.getByText("Copy saved.")).toBeVisible();
  await expect(page.getByText(/^Saved by hand, /)).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: /^Download the copy from .* \(private\)$/ }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^rise-bakery-copy-PRIVATE-\d{4}-\d{2}-\d{2}\.db\.gz$/);
  expect(readFileSync(await file.path()).subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));
});

test("the Owner puts the site back as it was in a copy, and everyone signs in again", async ({
  page,
  signedIn,
}) => {
  await createEntry(page, signedIn, { title: "Kept", body: "" });
  await page.goto(`${signedIn.base}/admin/settings/backups`);
  await page.getByRole("button", { name: "Save a copy now" }).click();
  await expect(page.getByText("Copy saved.")).toBeVisible();
  await createEntry(page, signedIn, { title: "Written after the copy", body: "" });

  await page.getByRole("button", { name: /^Restore the copy from / }).click();
  const dialog = page.getByRole("dialog", { name: /^Put the site back as it was on / });
  await expect(dialog.getByText(/^Everyone is signed out/)).toBeVisible();
  await dialog.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(dialog.getByText("Type your password.")).toBeVisible();
  await dialog.getByLabel("Your password").fill(OWNER.password);
  await dialog.getByRole("button", { name: "Restore", exact: true }).click();

  // Sign-in says why it's there.
  await expect(page.getByText(/^Rise Bakery is back as it was on /)).toBeVisible();
  await signIn(page, signedIn);
  const titles = await postTitles(page, signedIn);
  expect(titles).toContain("Kept");
  expect(titles).not.toContain("Written after the copy");
  // What was there is a copy too, so this can be undone the same way.
  await page.goto(`${signedIn.base}/admin/settings/backups`);
  await expect(page.getByText(/^Before a restore, /)).toBeVisible();
});

test("a downloaded backup is put back from Settings, once the password is right", async ({
  page,
  signedIn,
}) => {
  await page.goto(`${signedIn.base}/admin/settings/backups`);
  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download backup (private)" }).click();
  const zip = await (await download).path();
  await createEntry(page, signedIn, { title: "Written after the backup", body: "" });

  await page.getByLabel("Backup file").setInputFiles(zip);
  await page.getByRole("button", { name: "Restore this backup…" }).click();
  const dialog = page.getByRole("dialog", { name: /^Put the site back as it is in / });
  // A mistyped password is caught before any of the file is sent.
  await dialog.getByLabel("Your password").fill("not-the-password-at-all");
  await dialog.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(dialog.getByText(/^That isn't your password\./)).toBeVisible();
  await dialog.getByLabel("Your password").fill(OWNER.password);
  await dialog.getByRole("button", { name: "Restore", exact: true }).click();

  await expect(page.getByText(/^Rise Bakery is back as it was on /)).toBeVisible();
  await signIn(page, signedIn);
  expect(await postTitles(page, signedIn)).not.toContain("Written after the backup");
});

test("a site that would be lost with its container says so on every screen, backup first", async ({
  page,
  signedIn,
}) => {
  await pretendDataIsAtRisk(page, { why: "unnamed", path: "/data", platform: "docker" });
  const notice = page.getByRole("region", { name: "Your site could be lost" });
  await page.goto(`${signedIn.base}/admin/`);
  await expect(notice).toContainText("/data is on a volume with no name.");
  await expect(notice.getByRole("listitem")).toHaveText([
    "Download a backup",
    "Start Tend with a volume that has a name, for example: --volume tend-data:/data",
    "A new volume starts empty, so choose Start from a backup to put your site back.",
  ]);

  await page.getByRole("link", { name: "Posts" }).click();
  await expect(page.getByRole("heading", { name: "Posts", level: 1 })).toBeVisible();
  await notice.getByRole("link", { name: "Download a backup" }).click();
  await expect(page.getByRole("link", { name: "Download backup (private)" })).toBeVisible();
  await expect(notice).toBeVisible();
});

test("an Admin who isn't the Owner is told to ask the Owner for the backup", async ({
  page,
  signedIn,
}) => {
  await pretendDataIsAtRisk(
    page,
    { why: "unmounted", path: "/data", platform: "railway" },
    { isOwner: false },
  );
  const notice = page.getByRole("region", { name: "Your site could be lost" });
  await page.goto(`${signedIn.base}/admin/`);
  await expect(notice).toContainText("/data isn't on a volume, so your site is lost");
  await expect(notice.getByRole("listitem")).toHaveText([
    "Ask the Owner to download a backup.",
    "Attach a volume mounted at /data to this service in Railway.",
    "A new volume starts empty, so choose Start from a backup to put your site back.",
  ]);
  await expect(notice.getByRole("link")).toHaveCount(0);
});
