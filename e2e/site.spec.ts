import type { Page } from "@playwright/test";
import { createEntry, expect, photo, readEntry, test, upload } from "./fixtures.ts";

// Milestone 3: pictures, the site menu, design, business details and who can see the site.

const body = (page: Page) => page.getByRole("textbox", { name: "Text" });
const saveStatus = (page: Page) => page.getByTestId("save-status");

async function publishFromEditor(page: Page, type: "post" | "page" = "post"): Promise<void> {
  await expect(saveStatus(page)).toHaveText("Saved", { timeout: 10_000 });
  await page
    .getByRole("button", { name: type === "post" ? "Publish post" : "Publish page" })
    .click();
  const review = page.getByRole("dialog", { name: "Ready to publish?" });
  await review
    .getByRole("button", { name: type === "post" ? "Publish post now" : "Publish page now" })
    .click();
  await expect(
    page.getByRole("dialog", {
      name: type === "post" ? "Your post is on your site." : "Your page is on your site.",
    }),
  ).toBeVisible();
}

test.describe("pictures in the editor (J2)", () => {
  test("a photo chosen with Insert uploads in place, asks for a description, and shows on the post", async ({
    page,
    signedIn,
  }) => {
    const post = await createEntry(page, signedIn, {
      title: "Fresh loaves",
      body: "Out of the oven.",
    });
    const picture = await photo(page);
    await page.goto(`${signedIn.base}/admin/posts/${post.id}`);
    await body(page).click();
    await page.keyboard.press("ControlOrMeta+End");

    await page.getByRole("button", { name: "Insert +" }).click();
    await page.getByRole("menuitem", { name: "Image" }).click();
    const picker = page.getByRole("dialog", { name: "Add an image" });
    await expect(picker).toBeVisible();
    await picker.locator('input[type="file"]').setInputFiles({
      name: "loaves.jpg",
      mimeType: "image/jpeg",
      buffer: picture,
    });

    const describe = page.getByRole("dialog", { name: "Describe this image" });
    await expect(describe).toBeVisible({ timeout: 15_000 });
    await expect(describe.getByLabel("Description")).toBeFocused();
    await describe.getByLabel("Description").fill("Three loaves cooling on a rack");
    await describe.getByRole("button", { name: "Save" }).click();
    await expect(describe).toBeHidden();
    await expect(page.locator("[data-image-view] img")).toHaveAttribute(
      "alt",
      "Three loaves cooling on a rack",
    );

    await publishFromEditor(page);
    const visitor = await page.context().newPage();
    await visitor.goto(`${signedIn.base}/blog/fresh-loaves`);
    const image = visitor.locator("figure.t-image img");
    await expect(image).toHaveAttribute("alt", "Three loaves cooling on a rack");
    await expect(image).toHaveAttribute(
      "srcset",
      /480\.webp 480w, .*960\.webp 960w, .*1200\.webp 1200w/,
    );
    await expect(image).toHaveAttribute("fetchpriority", "high");
    // The browser really gets a picture.
    expect(
      await image.evaluate((element) => (element as HTMLImageElement).naturalWidth),
    ).toBeGreaterThan(0);
    // And it's the picture for sharing, too.
    await expect(visitor.locator('meta[property="og:image"]')).toHaveAttribute(
      "content",
      /\/1200\.webp$/,
    );
  });

  test("a photo dropped or pasted into the text uploads where it lands", async ({
    page,
    signedIn,
  }) => {
    const post = await createEntry(page, signedIn, { title: "Dropped", body: "First line" });
    const picture = (await photo(page, 800, 600)).toString("base64");
    await page.goto(`${signedIn.base}/admin/posts/${post.id}`);
    await body(page).click();

    await page.evaluate((base64) => {
      const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], "dropped.jpg", { type: "image/jpeg" }));
      const target = document.querySelector(".ProseMirror") as HTMLElement;
      const box = target.getBoundingClientRect();
      const at = { clientX: box.left + 20, clientY: box.bottom - 10 };
      target.dispatchEvent(
        new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true, ...at }),
      );
    }, picture);
    const describe = page.getByRole("dialog", { name: "Describe this image" });
    await expect(describe).toBeVisible({ timeout: 15_000 });
    await describe.getByRole("button", { name: "Not now" }).click();

    await body(page).click();
    await page.evaluate((base64) => {
      const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], "pasted.png", { type: "image/jpeg" }));
      const target = document.querySelector(".ProseMirror") as HTMLElement;
      target.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }),
      );
    }, picture);
    await expect(page.getByRole("dialog", { name: "Describe this image" })).toBeVisible({
      timeout: 15_000,
    });
    await page
      .getByRole("dialog", { name: "Describe this image" })
      .getByRole("button", { name: "Not now" })
      .click();

    await expect(saveStatus(page)).toHaveText("Saved", { timeout: 10_000 });
    const saved = await readEntry(page, signedIn, post.id);
    const images = saved.data.doc.content.filter((node: { type: string }) => node.type === "image");
    expect(images).toHaveLength(2);

    // Neither has a description, and the review says so before publishing.
    await page.getByRole("button", { name: "Publish post" }).click();
    const review = page.getByRole("dialog", { name: "Ready to publish?" });
    await expect(review.getByText("2 images have no description")).toBeVisible();
  });

  test("a HEIC photo is refused with steps to fix it, and nothing is lost", async ({
    page,
    signedIn,
  }) => {
    const post = await createEntry(page, signedIn, { title: "Phone photo", body: "Words stay." });
    await page.goto(`${signedIn.base}/admin/posts/${post.id}`);
    await page.getByRole("button", { name: "Insert +" }).click();
    await page.getByRole("menuitem", { name: "Image" }).click();
    const heic = Buffer.concat([
      Buffer.from([0, 0, 0, 24]),
      Buffer.from("ftypheic"),
      Buffer.from([0, 0, 0, 0]),
      Buffer.from("mif1heic"),
    ]);
    await page
      .getByRole("dialog", { name: "Add an image" })
      .locator('input[type="file"]')
      .setInputFiles({ name: "IMG_0042.HEIC", mimeType: "image/heic", buffer: heic });
    await expect(page.getByText(/HEIC photo/)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/Most Compatible/)).toBeVisible();
    await page.getByRole("button", { name: "Remove" }).click();
    await expect(body(page)).toContainText("Words stay.");
  });

  test("the featured image is chosen in settings, and shows on the blog list", async ({
    page,
    signedIn,
  }) => {
    const picture = await upload(page, signedIn, await photo(page), "cover.jpg");
    await page.request.patch(`${signedIn.base}/api/admin/media/${picture.id}`, {
      data: { alt: "Bakery front" },
    });
    const post = await createEntry(page, signedIn, { title: "Grand opening", body: "We're open." });
    await page.goto(`${signedIn.base}/admin/posts/${post.id}`);
    await page.getByText("Address, summary and more").click();
    await expect(page.getByText("Automatic: the first image")).toBeVisible();
    await page.getByRole("button", { name: "Choose image" }).click();
    const picker = page.getByRole("dialog", { name: "Choose the featured image" });
    await picker.getByRole("button", { name: /Bakery front/ }).click();
    await expect(page.getByRole("button", { name: "Change image" })).toBeVisible();
    await publishFromEditor(page);

    const visitor = await page.context().newPage();
    await visitor.goto(`${signedIn.base}/blog`);
    await expect(visitor.locator("img.t-img-card")).toHaveAttribute("alt", "");
    await visitor.goto(`${signedIn.base}/blog/grand-opening`);
    await expect(visitor.locator('meta[property="og:image:alt"]')).toHaveAttribute(
      "content",
      "Bakery front",
    );
  });
});

test.describe("the Media screen", () => {
  test("upload, describe, trash with Undo, and see what uses it", async ({ page, signedIn }) => {
    await page.goto(`${signedIn.base}/admin/media`);
    await expect(page.getByText("Nothing here yet")).toBeVisible();
    await page.locator('input[type="file"]').setInputFiles({
      name: "counter.jpg",
      mimeType: "image/jpeg",
      buffer: await photo(page, 900, 600, "#2a6f97"),
    });
    await expect(page.getByText("Uploaded counter.jpg.")).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: /counter\.jpg/ }).click();

    const details = page.getByRole("dialog", { name: "counter.jpg" });
    await expect(details.getByText("900 × 600 pixels")).toBeVisible();
    await details.getByLabel("Description").fill("The shop counter");
    await details.getByRole("button", { name: "Save" }).click();
    await expect(details.getByText("Saved. It's changed everywhere this is used.")).toBeVisible();
    await expect(details.getByText("Not used anywhere yet.")).toBeVisible();
    await details.getByRole("button", { name: "Move to Trash" }).click();
    await expect(details).toBeHidden();
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(page.getByText("It's back.")).toBeVisible();
    await expect(page.getByRole("button", { name: /counter\.jpg/ })).toBeVisible();

    await page.getByLabel("Search by name or description").fill("counter");
    await expect(page.getByRole("button", { name: /counter\.jpg/ })).toBeVisible();
    await page.getByLabel("Search by name or description").fill("nothing like it");
    await expect(page.getByText("Nothing matches that.")).toBeVisible();
  });
});

test.describe("the site menu (J4)", () => {
  test("links can be added, moved, indented and saved, with Undo", async ({ page, signedIn }) => {
    await createEntry(page, signedIn, { type: "page", title: "About", publish: true });
    await page.goto(`${signedIn.base}/admin/menu`);
    await expect(page.getByText(/For now, this menu has every published page/)).toBeVisible();

    await page.getByRole("button", { name: "Add link" }).click();
    const add = page.getByRole("dialog", { name: "Add a link" });
    await add.getByLabel(/Search your pages/).fill("https://example.com/shop");
    await add.getByRole("button", { name: "Link to https://example.com/shop" }).click();
    await page.getByRole("button", { name: 'Move "https://example.com/shop" up' }).click();
    await expect(page.getByRole("status").filter({ hasText: "Moved" })).toHaveText(
      'Moved "https://example.com/shop" up.',
    );
    await page.getByRole("button", { name: "Rename" }).nth(1).click();
    await page.getByLabel("Words in the menu").fill("Shop");
    await page.getByRole("button", { name: "Done" }).click();
    await page.getByRole("button", { name: "Save menu" }).click();
    await expect(page.getByText("Menu saved.")).toBeVisible();

    const visitor = await page.context().newPage();
    await visitor.goto(`${signedIn.base}/contact`);
    const menu = visitor.getByRole("navigation", { name: "Main" });
    // The automatic menu had About and Contact; Shop was added, then moved up one.
    await expect(menu.getByRole("link")).toHaveText(["About", "Shop", "Contact"]);
    await expect(menu.getByRole("link", { name: "Shop" })).toHaveAttribute(
      "href",
      "https://example.com/shop",
    );

    await page.getByRole("button", { name: "Undo" }).click();
    await expect(page.getByText("The menu is back as it was.")).toBeVisible();
    await visitor.reload();
    await expect(menu.getByRole("link")).toHaveText(["About", "Contact"]);
  });

  test("Show in site menu adds a new page when it's published", async ({ page, signedIn }) => {
    // A menu of its own, so new pages aren't added by themselves.
    await page.request.put(`${signedIn.base}/api/admin/menus/main`, {
      data: { items: [{ id: "home", label: "Home", target: { type: "home" }, children: [] }] },
    });
    const page2 = await createEntry(page, signedIn, { type: "page", title: "Opening hours" });
    await page.goto(`${signedIn.base}/admin/pages/${page2.id}`);
    await page.getByRole("button", { name: "Publish page" }).click();
    const review = page.getByRole("dialog", { name: "Ready to publish?" });
    await expect(review.getByLabel("Show in site menu")).toBeChecked();
    await review.getByRole("button", { name: "Publish page now" }).click();
    await expect(page.getByRole("dialog", { name: "Your page is on your site." })).toBeVisible();

    const visitor = await page.context().newPage();
    await visitor.goto(`${signedIn.base}/`);
    await expect(
      visitor
        .getByRole("navigation", { name: "Main" })
        .getByRole("link", { name: "Opening hours" }),
    ).toBeVisible();
  });
});

test.describe("design (J3)", () => {
  test("a hard-to-read colour is fixed, previewed, saved, and undone", async ({
    page,
    signedIn,
  }) => {
    await page.goto(`${signedIn.base}/admin/design`);
    const accent = page.getByRole("textbox", { name: "Accent colour", exact: true });
    await accent.fill("#ffcc00");
    await expect(page.getByText("Hard to read on white. Use #8c7000 instead?")).toBeVisible();
    await page.getByRole("button", { name: "Use it" }).click();
    await expect(accent).toHaveValue("#8c7000");
    await page.getByRole("radio", { name: /Classic/ }).check();

    await page.getByRole("button", { name: "Preview" }).click();
    const frame = page.frameLocator("dialog iframe[title]");
    await expect(frame.getByRole("heading", { level: 1 })).toBeVisible();
    // The theme's styles load in the preview, with the colour that isn't saved yet.
    const accentInPreview = await frame
      .locator("body")
      .evaluate((element) => getComputedStyle(element).getPropertyValue("--tend-accent").trim());
    expect(accentInPreview).toBe("#8c7000");
    await page.getByRole("button", { name: "Close" }).click();

    await page.getByRole("button", { name: "Save design" }).click();
    await expect(page.getByText("Design saved.")).toBeVisible();
    const visitor = await page.context().newPage();
    await visitor.goto(`${signedIn.base}/`);
    await expect(visitor.locator("html")).toHaveAttribute("data-fonts", "classic");

    await page.getByRole("button", { name: "Undo" }).click();
    await expect(page.getByText("The design is back as it was.")).toBeVisible();
    await expect(accent).toHaveValue("#1f6f4a");
    await visitor.reload();
    await expect(visitor.locator("html")).toHaveAttribute("data-fonts", "clean");
  });
});

test.describe("settings", () => {
  test("business details show on the Contact page, with a tap-to-call link", async ({
    page,
    signedIn,
  }) => {
    await page.goto(`${signedIn.base}/admin/settings/business`);
    await page.getByLabel("Address").fill("1 Main Street\nSpringfield");
    await page.getByLabel("Phone").fill("+1 (555) 010-0200");
    await page.getByRole("button", { name: "Add opening hours" }).click();
    await page.getByLabel("Note about opening hours").fill("Closed on public holidays");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Saved.", { exact: true })).toBeVisible();

    const visitor = await page.context().newPage();
    await visitor.goto(`${signedIn.base}/contact`);
    await expect(visitor.getByRole("link", { name: "Call +1 (555) 010-0200" })).toHaveAttribute(
      "href",
      "tel:+15550100200",
    );
    await expect(visitor.getByText("Closed on public holidays")).toBeVisible();
    await expect(visitor.getByRole("rowheader", { name: "Monday" })).toBeVisible();
  });

  test("Coming soon hides the site from visitors, but not from whoever's signed in", async ({
    page,
    signedIn,
    browser,
  }) => {
    await page.goto(`${signedIn.base}/admin/settings/general`);
    await page.getByRole("radio", { name: /Coming soon/ }).check();
    await page.getByRole("button", { name: "Save", exact: true }).nth(1).click();
    await expect(page.getByText("Saved.", { exact: true })).toBeVisible();

    const stranger = await (await browser.newContext()).newPage();
    const reply = await stranger.goto(`${signedIn.base}/contact`);
    expect(reply?.status()).toBe(503);
    await expect(stranger.getByText("This site is coming soon.")).toBeVisible();

    const mine = await page.context().newPage();
    expect((await mine.goto(`${signedIn.base}/contact`))?.status()).toBe(200);
  });
});

test.describe("fixes from review", () => {
  /** Holds uploads back for a while, like a slow connection. */
  async function slowUploads(page: Page, delayMs: number): Promise<void> {
    await page.route("**/api/admin/media", async (route) => {
      if (route.request().method() === "POST") {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      await route.fallback();
    });
  }

  async function dropPhoto(page: Page, base64: string, name = "dropped.jpg"): Promise<void> {
    await page.evaluate(
      ({ base64: data, name: fileName }) => {
        const bytes = Uint8Array.from(atob(data), (character) => character.charCodeAt(0));
        const transfer = new DataTransfer();
        transfer.items.add(new File([bytes], fileName, { type: "image/jpeg" }));
        const target = document.querySelector(".ProseMirror") as HTMLElement;
        const box = target.getBoundingClientRect();
        target.dispatchEvent(
          new DragEvent("drop", {
            dataTransfer: transfer,
            bubbles: true,
            cancelable: true,
            clientX: box.left + 20,
            clientY: box.bottom - 10,
          }),
        );
      },
      { base64, name },
    );
  }

  test("a picture still uploading says so, and the review warns before publishing", async ({
    page,
    signedIn,
  }) => {
    const post = await createEntry(page, signedIn, { title: "Slow", body: "Words." });
    const picture = (await photo(page, 600, 400)).toString("base64");
    await page.goto(`${signedIn.base}/admin/posts/${post.id}`);
    await slowUploads(page, 3000);
    await body(page).click();
    await dropPhoto(page, picture);
    await expect(saveStatus(page)).toContainText("Uploading 1 picture…");
    await page.getByRole("button", { name: "Publish post" }).click();
    const review = page.getByRole("dialog", { name: "Ready to publish?" });
    await expect(review.getByText(/1 picture is still uploading/)).toBeVisible();
    await review.getByRole("button", { name: "Not yet" }).click();
    await expect(saveStatus(page)).not.toContainText("Uploading", { timeout: 10_000 });
  });

  test("Undo while a picture uploads, then Redo, still ends with the picture", async ({
    page,
    signedIn,
  }) => {
    const post = await createEntry(page, signedIn, { title: "Undo me", body: "First line" });
    const picture = (await photo(page, 600, 400)).toString("base64");
    await page.goto(`${signedIn.base}/admin/posts/${post.id}`);
    await slowUploads(page, 1500);
    await body(page).click();
    await dropPhoto(page, picture);
    await expect(page.locator("[data-image-view] progress")).toBeVisible();
    await page.keyboard.press("ControlOrMeta+z");
    await expect(page.locator("[data-image-view]")).toHaveCount(0);
    // The upload finishes while its placeholder is gone.
    await page.waitForTimeout(2500);
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await expect(page.locator("[data-image-view] img")).toBeVisible();
    await expect(page.locator("[data-image-view] progress")).toHaveCount(0);
    await expect(saveStatus(page)).toHaveText("Saved", { timeout: 10_000 });
    const saved = await readEntry(page, signedIn, post.id);
    expect(saved.data.doc.content.some((node: { type: string }) => node.type === "image")).toBe(
      true,
    );
    // Arriving wasn't a step of its own: one Undo takes the whole picture away.
    await page.keyboard.press("ControlOrMeta+z");
    await expect(page.locator("[data-image-view]")).toHaveCount(0);
  });

  test("the description isn't asked for if typing carried on while it uploaded", async ({
    page,
    signedIn,
  }) => {
    const post = await createEntry(page, signedIn, { title: "Typing", body: "" });
    const picture = (await photo(page, 600, 400)).toString("base64");
    await page.goto(`${signedIn.base}/admin/posts/${post.id}`);
    await slowUploads(page, 1500);
    await body(page).click();
    await dropPhoto(page, picture);
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type("Still typing while it uploads");
    // Only once it has arrived: the placeholder shows the picture too, but faded.
    await expect(page.getByRole("button", { name: "Add description" })).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByRole("dialog", { name: "Describe this image" })).toHaveCount(0);
    await expect(body(page)).toContainText("Still typing while it uploads");
  });

  test("a toast that arrives while a dialog is open shows inside it, where it can be read", async ({
    page,
    signedIn,
  }) => {
    await upload(page, signedIn, await photo(page, 600, 400), "first.jpg");
    await page.goto(`${signedIn.base}/admin/media`);
    await slowUploads(page, 1500);
    await page.locator('input[type="file"]').setInputFiles({
      name: "second.jpg",
      mimeType: "image/jpeg",
      buffer: await photo(page, 600, 400, "#884422"),
    });
    await page.getByRole("button", { name: /first\.jpg/ }).click();
    const details = page.getByRole("dialog", { name: "first.jpg" });
    await expect(
      details.getByRole("status").filter({ hasText: "Uploaded second.jpg." }),
    ).toBeVisible({ timeout: 15_000 });
    await details.getByRole("button", { name: "Close" }).click();
    await expect(details).toBeHidden();
    await expect(
      page.getByRole("status").filter({ hasText: "Uploaded second.jpg." }),
    ).toBeVisible();
  });

  test("closing the picker mid-upload chooses nothing", async ({ page, signedIn }) => {
    const post = await createEntry(page, signedIn, { title: "Changed my mind", body: "Words." });
    await page.goto(`${signedIn.base}/admin/posts/${post.id}`);
    await slowUploads(page, 1500);
    await page.getByText("Address, summary and more").click();
    await page.getByRole("button", { name: "Choose image" }).click();
    const picker = page.getByRole("dialog", { name: "Choose the featured image" });
    await picker.locator('input[type="file"]').setInputFiles({
      name: "cover.jpg",
      mimeType: "image/jpeg",
      buffer: await photo(page, 600, 400),
    });
    await picker.getByRole("button", { name: "Close" }).click();
    await page.waitForTimeout(2500);
    await expect(page.getByText("Automatic: the first image")).toBeVisible();
  });

  test("menu changes wait if you go to another screen, and moving keeps your place", async ({
    page,
    signedIn,
  }) => {
    await createEntry(page, signedIn, { type: "page", title: "About", publish: true });
    await page.goto(`${signedIn.base}/admin/menu`);
    const down = page.getByRole("button", { name: 'Move "About" down' });
    await down.click();
    await expect(down).toBeFocused();
    await expect(page.getByText("Changes not saved yet.")).toBeVisible();
    // Putting it under another one moves it to a new list, and focus goes with it.
    const about = page.locator("[data-item]").filter({ hasText: "About" }).last();
    await about.getByRole("button", { name: "Put under the one above" }).click();
    await expect(page.locator(":focus")).toHaveText("Move out");

    await page.getByRole("link", { name: "Posts", exact: true }).click();
    await page.getByRole("link", { name: "Site menu" }).click();
    await expect(page.getByText("Changes not saved yet.")).toBeVisible();
    const rows = page.locator("[data-item] .font-medium");
    await expect(rows).toHaveText(["Contact", "About"]);
    await page.getByRole("button", { name: "Save menu" }).click();
    await expect(page.getByText("Menu saved.")).toBeVisible();
  });

  test("saving what's there already says so, with nothing to undo", async ({ page, signedIn }) => {
    // A design saved once already, so there's an earlier change an Undo could wrongly take back.
    const design = await (await page.request.get(`${signedIn.base}/api/admin/design`)).json();
    await page.request.put(`${signedIn.base}/api/admin/design`, {
      data: { ...design.value, footerText: "Made with flour" },
    });
    await page.goto(`${signedIn.base}/admin/design`);
    await page.getByRole("button", { name: "Add a social link" }).click();
    await page.getByRole("button", { name: "Save design" }).click();
    await expect(page.getByText("Nothing changed: that's how it was already.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Undo" })).toHaveCount(0);
    await expect(page.getByText("Changes not saved yet.")).toHaveCount(0);
    expect(
      (await (await page.request.get(`${signedIn.base}/api/admin/design`)).json()).value.footerText,
    ).toBe("Made with flour");
  });

  test("Show in site menu is only offered the first time a page is published", async ({
    page,
    signedIn,
  }) => {
    await page.request.put(`${signedIn.base}/api/admin/menus/main`, {
      data: { items: [{ id: "home", label: "Home", target: { type: "home" }, children: [] }] },
    });
    const live = await createEntry(page, signedIn, {
      type: "page",
      title: "Left out",
      publish: true,
    });
    // A picture with no description, so publishing these changes shows the review.
    const picture = await upload(page, signedIn, await photo(page, 600, 400), "plain.jpg");
    await page.request.patch(`${signedIn.base}/api/admin/entries/${live.id}`, {
      headers: { "If-Match": String(live.rev) },
      data: { doc: { type: "doc", content: [{ type: "image", attrs: { mediaId: picture.id } }] } },
    });
    await page.goto(`${signedIn.base}/admin/pages/${live.id}`);
    await page.getByRole("button", { name: "Publish changes" }).click();
    const review = page.getByRole("dialog", { name: "Ready to publish?" });
    await expect(review.getByText(/1 image has no description/)).toBeVisible();
    await expect(review.getByLabel("Show in site menu")).toHaveCount(0);
  });
});
