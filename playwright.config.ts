import { defineConfig, devices } from "@playwright/test";

// Each test starts its own server from the built package on a free port, so run
// `pnpm build` first. In Chromium and in WebKit, Safari's engine: the editor is the part most
// likely to differ between browsers, and many editors use Safari. WebKit here isn't iOS
// Safari, though: there's no on-screen keyboard, so real phones are still checked by hand.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: { trace: "retain-on-failure" },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  outputDir: "./test-results",
});
