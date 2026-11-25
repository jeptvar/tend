import { defineConfig, devices } from "@playwright/test";

// Each test starts its own server from the built package on a free port, so run
// `pnpm build` first. In Chromium and in WebKit, Safari's engine: the editor is the part most
// likely to differ between browsers, and many editors use Safari. WebKit here isn't iOS
// Safari, though: there's no on-screen keyboard, so real phones are still checked by hand.
const inEachBrowser = {
  testIgnore: ["**/budgets.spec.ts", "**/lighthouse.spec.ts", "**/timings.spec.ts"],
};

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: { trace: "retain-on-failure" },
  projects: [
    { name: "chromium", ...inEachBrowser, use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", ...inEachBrowser, use: { ...devices["Desktop Safari"] } },
    // What visitors download, counted on a screen the size of the phone Lighthouse pretends
    // to be (a Moto G Power), since the size of picture a browser picks depends on the screen.
    // Not with Chromium's phone emulation (isMobile), though. With it, Chromium picks each
    // picture for a 980 px wide screen first and fetches that too, before it reads the page's
    // viewport tag. Whether phones themselves do that is left to the check on a real phone.
    // Lighthouse has its own config: playwright.lighthouse.config.ts.
    {
      name: "budgets",
      testMatch: "**/budgets.spec.ts",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 412, height: 823 },
        deviceScaleFactor: 1.75,
      },
    },
    // How long things take, nightly: shared machines are too uneven for every pull request.
    { name: "timings", testMatch: "**/timings.spec.ts", use: { ...devices["Desktop Chrome"] } },
  ],
  outputDir: "./test-results",
});
