import type { Page } from "@playwright/test";
import {
  createEntry,
  expect,
  openSettings,
  photo,
  readEntry,
  type Site,
  test,
  upload,
} from "./fixtures.ts";

// The admin's look, as far as it does something: what's written looks as it will on the site,
// there's room for what's needed on any window, and lists and choices show what they're about.

const body = (page: Page) => page.getByRole("textbox", { name: "Text" });
const title = (page: Page) => page.getByLabel("Title", { exact: true });
const saveStatus = (page: Page) => page.getByTestId("save-status");
const text = (value: string) => ({ type: "text", text: value });
const heading = (value: string) => ({
  type: "heading",
  attrs: { level: 2 },
  content: [text(value)],
});
const paragraph = (value: string) => ({ type: "paragraph", content: [text(value)] });

async function patch(page: Page, site: Site, entry: { id: string; rev: number }, data: object) {
  const reply = await page.request.patch(`${site.base}/api/admin/entries/${entry.id}`, {
    headers: { "If-Match": String(entry.rev) },
    data,
  });
  expect(reply.status()).toBe(200);
}

async function setDesign(page: Page, site: Site, theme: Record<string, string>): Promise<void> {
  const { value } = await (await page.request.get(`${site.base}/api/admin/design`)).json();
  const reply = await page.request.put(`${site.base}/api/admin/design`, {
    data: { ...value, theme: { ...value.theme, ...theme } },
  });
  expect(reply.status()).toBe(200);
}

/** A picture in Media that's been described. */
async function describedPhoto(page: Page, site: Site, name: string, color?: string) {
  const picture = await upload(page, site, await photo(page, 1200, 800, color), `${name}.jpg`);
  await page.request.patch(`${site.base}/api/admin/media/${picture.id}`, { data: { alt: name } });
  return picture;
}

test.describe("what's being written", () => {
  test("is in the site's own fonts and colour", async ({ page, signedIn }) => {
    await setDesign(page, signedIn, { accent: "#8a4b1f", fonts: "classic" });
    const post = await createEntry(page, signedIn, { title: "Rye" });
    await patch(page, signedIn, post, {
      doc: {
        type: "doc",
        content: [heading("On Fridays"), { type: "button", attrs: { href: "/x", label: "Order" } }],
      },
    });
    await page.goto(`${signedIn.base}/admin/posts/${post.id}`);
    for (const words of [title(page), body(page).locator("h2")]) {
      await expect(words).toHaveCSS("font-family", /^Fraunces/);
      await expect(words).toHaveCSS("font-weight", "560");
    }
    await expect(page.getByRole("button", { name: 'Edit "Order" button' })).toHaveCSS(
      "background-color",
      "rgb(138, 75, 31)",
    );
    // Really there, from the site itself.
    await expect
      .poll(() => page.evaluate(() => document.fonts.check("560 40px Fraunces", "Rye")))
      .toBe(true);
  });

  test("has a title that shows all of itself, and is one line however it's pasted", async ({
    page,
    signedIn,
  }) => {
    const post = await createEntry(page, signedIn, { title: "Short", body: "" });
    await page.goto(`${signedIn.base}/admin/posts/${post.id}`);
    const height = async () => (await title(page).boundingBox())?.height ?? 0;
    const short = await height();
    await title(page).fill("A title that goes on for a good while ".repeat(5).trim());
    expect(await height()).toBeGreaterThan(short * 1.8);
    // No line of it is out of sight. A letter may reach a little past its own.
    const hidden = () =>
      title(page).evaluate((element) => element.scrollHeight - element.clientHeight);
    expect(await hidden()).toBeLessThan(10);

    await title(page).fill("Open again\r\n  from Monday");
    await expect(title(page)).toHaveValue("Open again from Monday");
    await title(page).press("Enter");
    await expect(body(page)).toBeFocused();
    await expect(title(page)).toHaveValue("Open again from Monday");
  });

  test("has its styles in a menu that says which it is", async ({ page, signedIn }) => {
    const post = await createEntry(page, signedIn, { title: "Hours", body: "" });
    await page.goto(`${signedIn.base}/admin/posts/${post.id}`);
    await body(page).click();
    await page.keyboard.type("Opening times");
    await page.getByRole("button", { name: "Text style: Text" }).click();
    await expect(page.getByRole("menuitemradio", { name: "Text" })).toBeFocused();
    await page.getByRole("menuitemradio", { name: "Subheading" }).click();
    await expect(body(page).locator("h3")).toHaveText("Opening times");
    const style = page.getByRole("button", { name: "Text style: Subheading" });
    await style.click();
    await expect(page.getByRole("menuitemradio", { name: "Subheading" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await page.getByRole("menuitemradio", { name: "Text", exact: true }).click();
    await expect(body(page).locator("h3")).toHaveCount(0);

    const list = page.getByRole("button", { name: "Bulleted list" });
    await list.click();
    await expect(list).toHaveAttribute("aria-pressed", "true");
    await expect(body(page).locator("ul")).toHaveText("Opening times");
    await expect(body(page)).toBeFocused();
  });

  test("shows a Big intro's photo where it'll be, with the words still easy to change", async ({
    page,
    signedIn,
  }) => {
    const first = await describedPhoto(page, signedIn, "Loaves");
    const second = await describedPhoto(page, signedIn, "Oven", "#335577");
    const entry = await createEntry(page, signedIn, { type: "page", title: "Welcome" });
    await patch(page, signedIn, entry, {
      doc: {
        type: "doc",
        content: [
          {
            type: "section",
            attrs: { kind: "intro", preset: "1", tone: "accent", align: "left" },
            content: [heading("Bread that takes its time"), paragraph("Every morning.")],
          },
        ],
      },
    });
    await page.goto(`${signedIn.base}/admin/pages/${entry.id}`);
    const layout = page.getByLabel("Layout");
    await expect(layout.locator("option")).toHaveText(["Standard", "Tall"]);
    await page.getByRole("button", { name: "Add a photo" }).click();
    await page
      .getByRole("dialog", { name: "Add an image" })
      .getByRole("button", { name: "Loaves" })
      .click();
    await expect(body(page)).toBeFocused();
    const image = body(page).locator("img").first();
    await expect(image).toHaveAttribute("alt", "Loaves");
    await expect(layout.locator("option")).toHaveText([
      "Photo beside the words",
      "Photo behind the words",
    ]);
    await expect(page.getByRole("button", { name: "Add a photo" })).toHaveCount(0);

    const words = body(page).locator("h2");
    const box = async (what: typeof words) =>
      (await what.boundingBox()) as { x: number; y: number; width: number; height: number };
    // Beside them: neither is on the other.
    expect((await box(words)).x + (await box(words)).width).toBeLessThanOrEqual(
      (await box(image)).x,
    );
    await layout.selectOption("Photo behind the words");
    await expect
      .poll(async () => {
        const [inner, outer] = [await box(words), await box(image)];
        return (
          inner.x > outer.x &&
          inner.y > outer.y &&
          inner.x + inner.width < outer.x + outer.width &&
          inner.y + inner.height < outer.y + outer.height
        );
      })
      .toBe(true);
    // The words are in front, so they're what a press lands on.
    await words.click({ position: { x: 12, y: 12 } });
    await page.keyboard.press("Home");
    await page.keyboard.type("Good ");
    await expect(words).toHaveText("Good Bread that takes its time");

    // Another photo takes its place, with the words as they were.
    await image.hover({ position: { x: 720, y: 200 } });
    await page.getByRole("button", { name: "Change image" }).click();
    await page
      .getByRole("dialog", { name: "Add an image" })
      .getByRole("button", { name: "Oven" })
      .click();
    await expect(image).toHaveAttribute("alt", "Oven");
    await expect(saveStatus(page)).toHaveText("Saved", { timeout: 5000 });
    const saved = await readEntry(page, signedIn, entry.id);
    const [section] = saved.data.doc.content;
    expect(section.attrs).toMatchObject({ kind: "intro", preset: "2" });
    expect(section.content[0].attrs.mediaId).toBe(second.id);
    expect(second.id).not.toBe(first.id);
    expect(JSON.stringify(section)).toContain("Good Bread that takes its time");
  });
});

test.describe("a post's settings", () => {
  test("are beside it where there's room, until someone hides them", async ({ page, signedIn }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    const post = await createEntry(page, signedIn, { title: "Rye", body: "On Fridays." });
    await page.goto(`${signedIn.base}/admin/posts/${post.id}`);
    const panel = page.getByRole("complementary", { name: "Post settings" });
    const toggle = page.getByRole("button", { name: "Post settings" });
    await expect(panel.getByLabel("Summary")).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await toggle.click();
    await expect(panel).toHaveCount(0);
    await page.reload();
    await expect(body(page)).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(panel).toHaveCount(0);
    await toggle.click();
    await expect(panel.getByLabel("Page address")).toBeVisible();
  });

  test("are a drawer where there isn't, which gives focus back", async ({ page, signedIn }) => {
    await page.setViewportSize({ width: 1000, height: 800 });
    const post = await createEntry(page, signedIn, { title: "Rye", body: "On Fridays." });
    await page.goto(`${signedIn.base}/admin/posts/${post.id}`);
    const toggle = page.getByRole("button", { name: "Post settings" });
    await expect(toggle).toBeVisible();
    await expect(page.getByLabel("Summary")).toHaveCount(0);
    await toggle.focus();
    await page.keyboard.press("Enter");
    const drawer = page.getByRole("dialog", { name: "Post settings" });
    await drawer.getByLabel("Summary").fill("Dark, with caraway");
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
    await expect(toggle).toBeFocused();
    await expect(saveStatus(page)).toHaveText("Saved", { timeout: 5000 });
    expect((await readEntry(page, signedIn, post.id)).data.summary).toBe("Dark, with caraway");
  });

  test("make way for a choice that has to be made on the page", async ({ page, signedIn }) => {
    await page.setViewportSize({ width: 1000, height: 800 });
    const post = await createEntry(page, signedIn, { title: "Rye", body: "On Fridays." });
    await page.goto(`${signedIn.base}/admin/posts/${post.id}`);
    await expect(body(page)).toBeVisible();
    await openSettings(page);
    // Someone else saves it meanwhile.
    await patch(page, signedIn, post, { title: "Rye and wheat" });
    await page.getByLabel("Summary").fill("Dark, with caraway");
    await expect(page.getByText("Choose which version to carry on with.")).toBeVisible({
      timeout: 8000,
    });
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.getByRole("button", { name: "Use this one" }).click();
    await expect(saveStatus(page)).toHaveText("Saved", { timeout: 5000 });
  });
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the tools are at the bottom, above the keyboard, and their menu fits", async ({
    page,
    signedIn,
  }) => {
    const post = await createEntry(page, signedIn, { title: "Rye", body: "On Fridays." });
    await page.goto(`${signedIn.base}/admin/posts/${post.id}`);
    const tools = page.locator(".tend-tools");
    const bottom = async () => {
      const box = await tools.boundingBox();
      return Math.round((box?.y ?? 0) + (box?.height ?? 0));
    };
    await expect(tools).toBeVisible();
    expect(await bottom()).toBe(844);
    // Every tool is on the screen.
    for (const button of await tools.getByRole("button").all()) {
      const box = await button.boundingBox();
      expect((box?.x ?? -1) >= 0 && (box?.x ?? 0) + (box?.width ?? 0) <= 390).toBe(true);
    }

    await page.getByRole("button", { name: "Insert", exact: true }).click();
    const menu = await page.getByRole("menu").boundingBox();
    expect(menu?.y ?? -1).toBeGreaterThanOrEqual(0);
    expect((menu?.x ?? -1) >= 0 && (menu?.x ?? 0) + (menu?.width ?? 0) <= 390).toBe(true);
    await page.keyboard.press("Escape");

    // As a keyboard that covers the bottom of the window leaves it.
    await page.evaluate(() => {
      const view = window.visualViewport as VisualViewport;
      Object.defineProperty(view, "height", { configurable: true, value: 500 });
      view.dispatchEvent(new Event("resize"));
    });
    await expect.poll(bottom).toBe(500);
  });

  test("Publish, Preview and the settings are in reach, and History in the settings", async ({
    page,
    signedIn,
  }) => {
    const post = await createEntry(page, signedIn, { title: "Rye", body: "On Fridays." });
    await page.goto(`${signedIn.base}/admin/posts/${post.id}`);
    for (const name of ["Publish post", "Preview", "Post settings"]) {
      const box = await page.getByRole("button", { name }).boundingBox();
      expect((box?.y ?? 99) + (box?.height ?? 0), name).toBeLessThanOrEqual(60);
      expect((box?.x ?? 0) + (box?.width ?? 999), name).toBeLessThanOrEqual(390);
    }
    await openSettings(page);
    await page
      .getByRole("dialog", { name: "Post settings" })
      .getByRole("button", { name: "History" })
      .click();
    await expect(page.getByRole("dialog", { name: "History" })).toBeVisible();
  });
});

test.describe("the rest of the admin", () => {
  test("greets whoever it is, by the time of day", async ({ page, signedIn }) => {
    for (const [hour, greeting] of [
      [8, "Good morning, Sam"],
      [14, "Good afternoon, Sam"],
      [21, "Good evening, Sam"],
    ] as const) {
      await page.clock.setFixedTime(new Date(2026, 10, 25, hour, 5));
      await page.goto(`${signedIn.base}/admin/`);
      await expect(page.getByRole("heading", { name: greeting, level: 1 })).toBeVisible();
    }
  });

  test("a post's picture and first words are in its row, and all of it leads there", async ({
    page,
    signedIn,
  }) => {
    const picture = await describedPhoto(page, signedIn, "Loaves");
    const post = await createEntry(page, signedIn, { title: "Rye" });
    await patch(page, signedIn, post, {
      doc: {
        type: "doc",
        content: [
          { type: "image", attrs: { mediaId: picture.id } },
          paragraph("Dark, with caraway."),
        ],
      },
    });
    await page.goto(`${signedIn.base}/admin/posts`);
    const row = page.locator("[data-entry-row]").filter({ hasText: "Rye" });
    await expect(row).toContainText("Dark, with caraway.");
    const loaded = () =>
      row.locator("img").evaluate((image) => (image as HTMLImageElement).naturalWidth);
    await expect.poll(loaded).toBeGreaterThan(0);
    // Not the words: on the picture.
    await row.click({ position: { x: 40, y: 40 } });
    await expect(title(page)).toHaveValue("Rye");
  });

  test("Design's choices look like what they choose", async ({ page, signedIn }) => {
    await page.goto(`${signedIn.base}/admin/design`);
    const accent = page.getByRole("textbox", { name: "Accent colour", exact: true });
    const blue = page.getByRole("button", { name: "Blue" });
    await blue.click();
    await expect(accent).toHaveValue("#2451b8");
    await expect(blue).toHaveAttribute("aria-pressed", "true");

    const sample = (value: string) => page.locator(`[data-font-choice="${value}"]`);
    await expect(sample("classic")).toHaveCSS("font-family", /^Fraunces/);
    await expect(sample("friendly")).toHaveCSS("font-family", /^Nunito/);
    await expect(sample("clean")).toHaveCSS("font-family", /system-ui/);
    // Once Classic is the site's, the others still look like themselves.
    await page.getByRole("radio", { name: "Classic" }).check();
    await page.getByRole("button", { name: "Save design" }).click();
    await expect(page.getByText("Design saved.")).toBeVisible();
    await page.reload();
    await expect(sample("friendly")).toHaveCSS("font-family", /^Nunito/);
    await expect(sample("clean")).toHaveCSS("font-family", /system-ui/);
  });
});
