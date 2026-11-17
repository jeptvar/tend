import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "./fixtures.ts";
import { buildStarterSite, STARTERS } from "./starter-sites.ts";

// Lighthouse on every starting point as it comes, plus the Blog's first post (PLAN.md §11),
// nightly and on release tags, held to tools/lighthouse/lighthouserc.yml. Pages filled in
// with photos are held to their byte budgets on every pull request instead
// (e2e/budgets.spec.ts): with a detailed photo first, Lighthouse's LCP was 1.51 to 1.65 s
// in November 2026, just over the plan's 1.5 s.
//
// To run it here: `pnpm build`, then once `pnpm --dir tools/lighthouse install`, then
// `pnpm lighthouse`. CHROME_PATH picks a Chrome other than Playwright's Chromium. The
// reports are kept in test-results/lighthouse.

const TOOLS = join(import.meta.dirname, "..", "tools", "lighthouse");
const LHCI = join(TOOLS, "node_modules", "@lhci", "cli", "src", "cli.js");
const CONFIG = join(TOOLS, "lighthouserc.yml");

function lhci(args: string[], cwd: string): Promise<{ ok: boolean; output: string }> {
  const child = spawn(process.execPath, [LHCI, ...args, `--config=${CONFIG}`], { cwd });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  return new Promise((resolve) => child.on("close", (code) => resolve({ ok: code === 0, output })));
}

test.beforeAll(() => {
  if (!existsSync(LHCI)) {
    throw new Error("Lighthouse isn't installed. Run: pnpm --dir tools/lighthouse install");
  }
});

for (const starter of STARTERS) {
  test(`${starter}: Lighthouse scores and timings stay within the budgets`, async ({
    page,
    site,
    playwright,
  }) => {
    const urls = await buildStarterSite(page, site, starter, "as it comes");
    // In this test's own folder, where Lighthouse CI keeps its runs between its commands.
    const folder = test.info().outputPath();
    // Playwright's Chromium, or another Chrome named the way Lighthouse lets you name one.
    const chrome = process.env.CHROME_PATH || playwright.chromium.executablePath();
    const collected = await lhci(
      ["collect", `--chromePath=${chrome}`, ...urls.map((url) => `--url=${url}`)],
      folder,
    );
    expect(collected.ok, collected.output).toBe(true);
    const checked = await lhci(["assert"], folder);
    await lhci(["upload", "--target=filesystem", `--outputDir=${join(folder, "reports")}`], folder);
    expect(checked.ok, checked.output).toBe(true);
  });
}
