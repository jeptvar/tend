import { defineConfig, devices } from "@playwright/test";

// Each test starts its own server from the built package on a free port, so run
// `pnpm build` first. Only Chromium for now; WebKit joins when the real editor arrives.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: { ...devices["Desktop Chrome"], trace: "retain-on-failure" },
  outputDir: "./test-results",
});
