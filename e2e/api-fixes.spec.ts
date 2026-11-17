import type { Page } from "@playwright/test";
import { createEntry, expect, photo, type Site, test, upload } from "./fixtures.ts";

const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");

function linkTo(text: string, href: string) {
  return {
    type: "paragraph",
    content: [{ type: "text", text, marks: [{ type: "link", attrs: { href } }] }],
  };
}

/** Saves a document into something, then publishes it if asked. */
async function saveDoc(
  page: Page,
  site: Site,
  entry: { id: string; rev: number },
  content: unknown[],
  options: { publish?: boolean } = {},
) {
  const path = `${site.base}/api/admin/entries/${entry.id}`;
  const saved = await page.request.patch(path, {
    headers: { "If-Match": String(entry.rev) },
    data: { doc: { type: "doc", content } },
  });
  expect(saved.status()).toBe(200);
  if (!options.publish) return;
  const published = await page.request.post(`${path}/publish`, {
    headers: { "If-Match": String((await saved.json()).rev) },
    data: {},
  });
  expect(published.status()).toBe(200);
}

test.describe("Media after review (api)", () => {
  test("an upload Tend is too busy for waits a moment and goes by itself", async ({
    page,
    signedIn,
  }) => {
    const picture = await photo(page, 300, 200);
    let tries = 0;
    await page.route("**/api/admin/media", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      tries++;
      if (tries > 1) return route.fallback();
      await route.fulfill({
        status: 503,
        headers: { "Retry-After": "1" },
        json: {
          error: {
            code: "uploads_busy",
            message: "Tend is busy with other uploads right now.",
            fix: "Wait a moment, then try again.",
          },
        },
      });
    });
    await page.goto(`${signedIn.base}/admin/media`);
    await page.locator('input[type="file"]').setInputFiles({
      name: "counter.jpg",
      mimeType: "image/jpeg",
      buffer: picture,
    });
    await expect(page.getByText("Uploaded counter.jpg.")).toBeVisible({ timeout: 15_000 });
    expect(tries).toBe(2);
    await expect(page.getByText("Tend is busy with other uploads")).toHaveCount(0);
  });

  test("an upload that stopped arriving says so, and goes when tried again", async ({
    page,
    signedIn,
  }) => {
    const picture = await photo(page, 300, 200);
    const stalled = [
      // Tend's own answer, once nothing more of the file has arrived for a while.
      {
        status: 408,
        json: {
          error: {
            code: "upload_stalled",
            message: "That file stopped arriving partway through, so it wasn't uploaded.",
            fix: "Check your connection, then try again.",
          },
        },
      },
      // A proxy in front of Tend giving up first, with a page of its own.
      { status: 408, contentType: "text/html", body: "<h1>408 Request Timeout</h1>" },
    ];
    let tries = 0;
    await page.route("**/api/admin/media", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      const answer = stalled[tries++];
      return answer ? route.fulfill(answer) : route.fallback();
    });
    await page.goto(`${signedIn.base}/admin/media`);
    await page.locator('input[type="file"]').setInputFiles({
      name: "counter.jpg",
      mimeType: "image/jpeg",
      buffer: picture,
    });
    const uploads = page.getByRole("list", { name: "Uploading" });
    for (let sent = 1; sent <= stalled.length; sent++) {
      await expect.poll(() => tries).toBe(sent);
      await expect(uploads.getByRole("alert")).toHaveText(
        "That file stopped arriving partway through, so it wasn't uploaded. Check your connection, then try again.",
      );
      await uploads.getByRole("button", { name: "Try again" }).click();
    }
    await expect(page.getByText("Uploaded counter.jpg.")).toBeVisible({ timeout: 15_000 });
    expect(tries).toBe(3);
  });

  test("moving a PDF a page links to into the Trash says the link leads nowhere", async ({
    page,
    signedIn,
  }) => {
    const file = await upload(page, signedIn, PDF, "Lunch menu.pdf");
    const lunch = await createEntry(page, signedIn, { type: "page", title: "Lunch" });
    await saveDoc(page, signedIn, lunch, [linkTo("Lunch menu.pdf", file.url)], { publish: true });

    await page.goto(`${signedIn.base}/admin/media`);
    await page.getByRole("button", { name: /Lunch menu\.pdf/ }).click();
    const details = page.getByRole("dialog", { name: "Lunch menu.pdf" });
    await expect(details.getByRole("link", { name: "Lunch" })).toBeVisible();
    await details.getByRole("button", { name: "Move to Trash" }).click();
    await expect(
      page.getByText(
        "Moved to the Trash. It's still linked from 1 page of your site, but that link leads nowhere until you restore it.",
      ),
    ).toBeVisible();
  });

  test("a link in the site menu shows as Site menu, and the Trash says it leads nowhere", async ({
    page,
    signedIn,
  }) => {
    const file = await upload(page, signedIn, PDF, "Price list.pdf");
    // What Tend says about a file the site menu links to.
    const menuUse = { id: "menu", type: "menu", title: "", url: "/", inDraft: false };
    await page.route(`**/api/admin/media/${file.id}/usage`, (route) =>
      route.fulfill({ json: { uses: [menuUse] } }),
    );
    await page.route(`**/api/admin/media/${file.id}/trash`, async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...(await response.json()), uses: [menuUse] } });
    });

    await page.goto(`${signedIn.base}/admin/media`);
    await page.getByRole("button", { name: /Price list\.pdf/ }).click();
    const details = page.getByRole("dialog", { name: "Price list.pdf" });
    await expect(details.getByRole("link", { name: "Site menu" })).toHaveAttribute(
      "href",
      "/admin/menu",
    );
    await details.getByRole("button", { name: "Move to Trash" }).click();
    await expect(
      page.getByText(
        "Moved to the Trash. It's still linked from your site menu, but that link leads nowhere until you restore it.",
      ),
    ).toBeVisible();
  });

  test("a post with hundreds of pictures has them all looked up, a batch at a time", async ({
    page,
    signedIn,
  }) => {
    test.setTimeout(120_000);
    const picture = await photo(page, 16, 16);
    const ids: string[] = [];
    for (let index = 0; index < 205; index++) {
      ids.push((await upload(page, signedIn, picture, `${index}.jpg`)).id);
    }
    const gallery = await createEntry(page, signedIn, { title: "Gallery" });
    await saveDoc(
      page,
      signedIn,
      gallery,
      ids.map((mediaId) => ({ type: "image", attrs: { mediaId } })),
    );

    const asked: number[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      const wanted = url.searchParams.get("ids");
      if (url.pathname === "/api/admin/media" && wanted) asked.push(wanted.split(",").length);
    });
    await page.goto(`${signedIn.base}/admin/posts/${gallery.id}`);
    await page.getByRole("button", { name: "Publish post" }).click();
    const review = page.getByRole("dialog", { name: "Ready to publish?" });
    await expect(review.getByText("205 images have no description", { exact: false })).toBeVisible({
      timeout: 15_000,
    });
    await expect(review.getByText("in the Trash or deleted", { exact: false })).toHaveCount(0);
    expect(asked.length).toBeGreaterThan(0);
    expect(Math.max(...asked)).toBeLessThanOrEqual(200);
  });
});
