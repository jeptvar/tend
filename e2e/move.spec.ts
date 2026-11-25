import { writeFileSync } from "node:fs";
import { expect, GREETING, OWNER, photo, signIn, test, upload } from "./fixtures.ts";

// J10 (PLAN.md): moving a site. A backup downloaded from one site starts another, at another
// address, with everything in it, and nothing on the new site names the old address.

test("a backup moves a site to a new address: its pages, pictures and sign-ins", async ({
  page,
  signedIn: old,
  newSite,
}, testInfo) => {
  // The old site has a post with a picture in it.
  const picture = await upload(page, old, await photo(page), "loaves.jpg");
  const entries = `${old.base}/api/admin/entries`;
  const created = await (await page.request.post(entries, { data: { type: "post" } })).json();
  const saved = await (
    await page.request.patch(`${entries}/${created.id}`, {
      headers: { "If-Match": String(created.rev) },
      data: {
        title: "Fresh loaves",
        doc: {
          type: "doc",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "Out of the oven." }] },
            { type: "image", attrs: { mediaId: picture.id, alt: "Loaves cooling" } },
          ],
        },
        featuredImage: { mediaId: picture.id, alt: "Loaves cooling" },
      },
    })
  ).json();
  const published = await page.request.post(`${entries}/${created.id}/publish`, {
    headers: { "If-Match": String(saved.rev) },
    data: {},
  });
  expect(published.status()).toBe(200);

  const download = await page.request.get(`${old.base}/api/admin/backups/download`);
  expect(download.status()).toBe(200);
  const backup = testInfo.outputPath("rise-bakery-backup-PRIVATE.zip");
  writeFileSync(backup, await download.body());

  // The new site is at another address: 127.0.0.1 rather than localhost.
  const base = newSite.base.replace("//localhost:", "//127.0.0.1:");
  expect(base).not.toBe(newSite.base);
  await page.goto(newSite.link.replace(newSite.base, base));
  await page.getByRole("link", { name: /Start from a backup/ }).click();
  await expect(page.getByRole("heading", { name: "Start from a backup" })).toBeVisible();

  // A file that isn't a backup is caught before any of it is sent.
  const file = page.getByLabel("Backup file");
  await file.setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Not a backup"),
  });
  await page.getByRole("button", { name: "Restore this backup" }).click();
  await expect(page.getByText("That isn't a Tend backup.")).toBeVisible();
  await expect(file).toBeFocused();

  await file.setInputFiles(backup);
  await page.getByRole("button", { name: "Restore this backup" }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible({ timeout: 30_000 });
  await expect(
    page.getByText("Rise Bakery is back, with everything from your backup."),
  ).toBeVisible();
  await page.getByLabel("Email").fill(OWNER.email);
  await page.getByLabel("Password", { exact: true }).fill(OWNER.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: GREETING })).toBeVisible();

  // Visitors get the old site's post, picture and all.
  const visitor = await page.context().newPage();
  await visitor.goto(`${base}/blog/fresh-loaves`);
  await expect(visitor.getByRole("heading", { name: "Fresh loaves" })).toBeVisible();
  const image = visitor.locator("figure.t-image img");
  await expect(image).toHaveAttribute("alt", "Loaves cooling");
  await expect
    .poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth))
    .toBeGreaterThan(0);

  // Every address on it is the new one: links, sitemap and social previews.
  const html = await (await page.request.get(`${base}/blog/fresh-loaves`)).text();
  expect(html).toContain(`<link rel="canonical" href="${base}/blog/fresh-loaves">`);
  expect(html).toContain(`<meta property="og:url" content="${base}/blog/fresh-loaves">`);
  expect(html).toMatch(new RegExp(`<meta property="og:image" content="${base}/media/`));
  expect(html).not.toContain("localhost");
  const sitemap = await (await page.request.get(`${base}/sitemap.xml`)).text();
  expect(sitemap).toContain(`<loc>${base}/blog/fresh-loaves</loc>`);
  expect(sitemap).not.toContain("localhost");

  // It's the same site when Tend next starts, on an update for example.
  await newSite.crash();
  await newSite.restart();
  await visitor.reload();
  await expect(visitor.getByRole("heading", { name: "Fresh loaves" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: GREETING })).toBeVisible();
});

test("a site that's online is asked once whether the address it's at is its own", async ({
  page,
  signedIn,
}) => {
  // Browsers send any name under .localhost to this computer, and the admin doesn't count
  // one as local, so here the site looks online.
  const base = signedIn.base.replace("//localhost:", "//rise.localhost:");
  await signIn(page, { ...signedIn, base }, "/admin/login");
  const question = page.getByRole("region", { name: "Your site's address" });
  await expect(question).toContainText(`Your site is now at ${base}. Use this address?`);
  // Until it's confirmed, each page names the address it was asked for.
  const before = await (await page.request.get(`${signedIn.base}/`)).text();
  expect(before).toContain(`<link rel="canonical" href="${signedIn.base}/">`);

  await question.getByRole("button", { name: "Use this address" }).click();
  await expect(question.getByRole("status")).toHaveText(
    `Done. Links to your site now use ${base}.`,
  );
  await expect(question.getByRole("heading")).toBeFocused();
  // Every page names it now, whatever address it's asked for, and it isn't asked again.
  const after = await (await page.request.get(`${signedIn.base}/`)).text();
  expect(after).toContain(`<link rel="canonical" href="${base}/">`);
  await page.reload();
  await expect(page.getByRole("heading", { name: GREETING, level: 1 })).toBeVisible();
  await expect(question).toBeHidden();
});
