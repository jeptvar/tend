import type { Page } from "@playwright/test";
import { expect, type Site, test } from "./fixtures.ts";

// The accent colour on the Design screen is checked against every light background Meadow puts
// links on: the page, and sections with a Soft background, whose grey is a little darker.

test.use({ colorScheme: "light" });

/** Red, green, blue and how opaque, from a computed colour, as rgb() or color(srgb ...) gives it. */
function rgba(color: string): [number, number, number, number] {
  const [r = 0, g = 0, b = 0, alpha = 1] = (color.match(/[\d.]+/g) ?? []).map(Number);
  const scale = color.startsWith("color(") ? 255 : 1;
  return [r * scale, g * scale, b * scale, alpha];
}

/** A see-through colour laid over an opaque one, as it shows on screen. */
function over(top: string, below: string): [number, number, number] {
  const [r, g, b, alpha] = rgba(top);
  const under = rgba(below);
  return [r, g, b].map(
    (value, index) => value * alpha + (under[index] as number) * (1 - alpha),
  ) as [number, number, number];
}

/** WCAG 2.2's contrast ratio between two opaque colours. */
function contrast(first: [number, number, number], second: [number, number, number]): number {
  const luminance = (channels: [number, number, number]) => {
    const [r, g, b] = channels.map((value) => {
      const c = value / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [light, dark] = [luminance(first), luminance(second)].sort((a, b) => b - a) as [
    number,
    number,
  ];
  return (light + 0.05) / (dark + 0.05);
}

/** An email address in the business details, so the Contact page's Soft section has a link. */
async function setEmail(page: Page, site: Site): Promise<void> {
  const reply = await page.request.put(`${site.base}/api/admin/settings/business`, {
    data: {
      address: null,
      phone: null,
      email: "hello@example.com",
      mapUrl: null,
      hours: null,
      hoursNote: null,
    },
  });
  expect(reply.status()).toBe(200);
}

test.describe("the accent colour on the Design screen", () => {
  test("a colour that only just reads on white is fixed for Soft sections too", async ({
    page,
    signedIn,
  }) => {
    await setEmail(page, signedIn);
    await page.goto(`${signedIn.base}/admin/design`);
    const accent = page.getByRole("textbox", { name: "Accent colour", exact: true });
    // 4.70:1 on white, 4.19:1 on a Soft section's grey.
    await accent.fill("#e11d48");
    await expect(
      page.getByText("Hard to read in sections with a Soft background. Use #d61c44 instead?"),
    ).toBeVisible();
    // The longer warning still fits a phone's width, and its button is big enough to tap.
    await page.setViewportSize({ width: 320, height: 640 });
    const fit = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(fit.scrollWidth).toBeLessThanOrEqual(fit.clientWidth);
    const useIt = page.getByRole("button", { name: "Use it" });
    expect((await useIt.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await useIt.click();
    await expect(accent).toHaveValue("#d61c44");
    await expect(page.getByText(/Hard to read/)).toHaveCount(0);
    await page.getByRole("button", { name: "Save design" }).click();
    await expect(page.getByText("Design saved.")).toBeVisible();

    // On the site, the Contact page's details sit in a section with a Soft background.
    const visitor = await page.context().newPage();
    await visitor.goto(`${signedIn.base}/contact`);
    const email = visitor.locator(".t-tone-muted").getByRole("link", { name: "hello@example.com" });
    const colours = await email.evaluate((link) => ({
      link: getComputedStyle(link).color,
      section: getComputedStyle(link.closest(".t-tone-muted") as HTMLElement).backgroundColor,
      page: getComputedStyle(document.body).backgroundColor,
    }));
    expect(colours.link).toBe("rgb(214, 28, 68)");
    const behind = over(colours.section, colours.page);
    expect(contrast(over(colours.link, colours.page), behind)).toBeGreaterThanOrEqual(4.5);
  });

  test("a colour hard to read on white is fixed for Soft sections too", async ({
    page,
    signedIn,
  }) => {
    await page.goto(`${signedIn.base}/admin/design`);
    const accent = page.getByRole("textbox", { name: "Accent colour", exact: true });
    await accent.fill("#ffcc00");
    await expect(page.getByText("Hard to read on white. Use #806600 instead?")).toBeVisible();
    await page.getByRole("button", { name: "Use it" }).click();
    await expect(accent).toHaveValue("#806600");
    // What it suggested isn't hard to read anywhere, so nothing more is asked.
    await expect(page.getByText(/Hard to read/)).toHaveCount(0);
  });
});
