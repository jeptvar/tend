import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { createEntry, expect, type Site, test } from "./fixtures.ts";

async function expectNoViolations(page: Page, name: string): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  const problems = results.violations.map((violation) => ({
    rule: violation.id,
    where: violation.nodes.map((node) => node.target.join(" ")),
  }));
  expect(problems, name).toEqual([]);
}

/** Everything can be reached and read at the narrowest width the plan asks for. */
async function expectNoSidewaysScrolling(page: Page, name: string): Promise<void> {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth, name).toBeLessThanOrEqual(clientWidth);
}

async function adminScreens(page: Page, site: Site): Promise<[string, string][]> {
  const post = await createEntry(page, site, { title: "A post", publish: true });
  return [
    ["overview", "/admin/"],
    ["posts", "/admin/posts"],
    ["pages", "/admin/pages"],
    ["editor", `/admin/posts/${post.id}`],
  ];
}

for (const colorScheme of ["light", "dark"] as const) {
  test.describe(`in ${colorScheme} mode`, () => {
    test.use({ colorScheme });

    test("setup screens have no accessibility violations", async ({ page, site }) => {
      await page.goto(`${site.base}/admin/setup`);
      await expect(page.getByLabel("Setup code")).toBeVisible();
      await expectNoViolations(page, "code");

      await page.goto(site.link);
      await expectNoViolations(page, "welcome");
      await page.getByRole("link", { name: /Start a new site/ }).click();
      await page.getByRole("button", { name: "Continue" }).click();
      await expect(page.getByText("Type a name for your site")).toBeVisible();
      await expectNoViolations(page, "name, with an error showing");
      await page.getByLabel("Site name").fill("Rise Bakery");
      await page.getByRole("button", { name: "Continue" }).click();
      await page.getByRole("button", { name: "Suggest a passphrase" }).click();
      await expectNoViolations(page, "account");
      await page.getByLabel("Your name").fill("Sam");
      await page.getByLabel("Email").fill("sam@example.com");
      await page.getByRole("button", { name: "Continue" }).click();
      await expect(page.getByRole("radio", { name: /Blog/ })).toBeVisible();
      await expectNoViolations(page, "starting point");
    });

    test("admin screens have no accessibility violations", async ({ page, signedIn }) => {
      for (const [name, path] of await adminScreens(page, signedIn)) {
        await page.goto(`${signedIn.base}${path}`);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        await page.waitForLoadState("networkidle");
        await expectNoViolations(page, name);
      }
    });

    test("the sign-in screens have no accessibility violations", async ({ page, signedIn }) => {
      await page.goto(`${signedIn.base}/admin/`);
      await page.getByRole("button", { name: "Sign out" }).click();
      await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
      await expectNoViolations(page, "sign in");
      await page.getByRole("link", { name: "Forgot password?" }).click();
      await expect(page.getByRole("heading", { name: "Forgot your password?" })).toBeVisible();
      await expectNoViolations(page, "forgot password");
    });

    test("the public site has no accessibility violations", async ({ page, signedIn }) => {
      const post = await createEntry(page, signedIn, {
        title: "A post",
        body: "Some words.",
        publish: true,
      });
      for (const path of ["/", "/contact", "/blog", post.url as string, "/does-not-exist"]) {
        await page.goto(`${signedIn.base}${path}`);
        await expectNoViolations(page, path);
      }
    });
  });
}

test.describe("at phone widths", () => {
  const UNBROKEN = "averyveryverylongwordwithnospaces".repeat(4);

  test("long unbroken names don't force sideways scrolling, even at 320 px", async ({
    page,
    signedIn,
  }) => {
    const post = await createEntry(page, signedIn, {
      title: UNBROKEN,
      body: UNBROKEN,
      publish: true,
    });
    const about = await createEntry(page, signedIn, {
      type: "page",
      title: UNBROKEN,
      publish: true,
    });
    await page.setViewportSize({ width: 320, height: 640 });
    for (const path of [
      "/admin/",
      "/admin/posts",
      "/admin/pages",
      `/admin/posts/${post.id}`,
      "/",
      "/blog",
      post.url as string,
      about.url as string,
    ]) {
      await page.goto(`${signedIn.base}${path}`);
      await page.waitForLoadState("networkidle");
      await expectNoSidewaysScrolling(page, path);
    }
  });

  test("everything tappable in the admin is at least 44 px", async ({ page, signedIn }) => {
    const post = await createEntry(page, signedIn, { title: "A post", publish: true });
    await page.setViewportSize({ width: 375, height: 812 });
    for (const path of ["/admin/", "/admin/posts", `/admin/posts/${post.id}`]) {
      await page.goto(`${signedIn.base}${path}`);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await page.waitForLoadState("networkidle");
      const tooSmall = await page.evaluate(() =>
        [...document.querySelectorAll("a, button")]
          .map((element) => {
            const { width, height } = element.getBoundingClientRect();
            return { text: element.textContent, width, height };
          })
          .filter(({ width, height }) => width < 44 || height < 44),
      );
      expect(tooSmall, path).toEqual([]);
    }
  });
});
