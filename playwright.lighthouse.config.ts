import { defineConfig, devices } from "@playwright/test";

// Lighthouse on every starting point and a post (e2e/lighthouse.spec.ts), nightly and on
// release tags. One test at a time, so runs don't slow each other down and skew the timings.
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/lighthouse.spec.ts",
  workers: 1,
  timeout: 20 * 60_000,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? "github" : "list",
  use: { ...devices["Desktop Chrome"], trace: "retain-on-failure" },
  outputDir: "./test-results/lighthouse",
});
