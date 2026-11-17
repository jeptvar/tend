import { defineConfig } from "tsdown";
import { thirdPartyNotices } from "../../scripts/third-party-notices.mjs";

export default defineConfig({
  entry: ["src/cli.ts"],
  platform: "node",
  target: "node24",
  dts: false,
  // dist/THIRD_PARTY_NOTICES.md: the licence of everything bundled below (PLAN.md §14).
  plugins: [thirdPartyNotices()],
  deps: {
    // Only the three native runtime dependencies stay external; pure-JS libraries
    // are devDependencies and get bundled (PLAN.md §7, P11). Anything else that
    // ends up in the bundle must be added here on purpose.
    neverBundle: ["better-sqlite3", "sharp", "@node-rs/argon2"],
    onlyBundle: ["hono", "@hono/node-server", "drizzle-orm", "zod", "liquidjs"],
  },
  copy: [
    { from: "../admin/dist", to: "dist", rename: "admin" },
    { from: "../../themes/meadow", to: "dist/themes" },
  ],
});
