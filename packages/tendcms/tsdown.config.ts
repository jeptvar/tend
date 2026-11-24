import { defineConfig } from "tsdown";
import { thirdPartyNotices } from "../../scripts/third-party-notices.mjs";

export default defineConfig({
  // cli.ts loads commands.ts only once it's checked that it can. As entries of their own, what
  // they share gets a file to itself. Otherwise it would be in cli.mjs, where importing it
  // could run Tend a second time.
  entry: ["src/cli.ts", "src/commands.ts"],
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
    onlyBundle: ["hono", "@hono/node-server", "drizzle-orm", "zod", "liquidjs", "fflate"],
  },
  copy: [
    { from: "../admin/dist", to: "dist", rename: "admin" },
    { from: "../../themes/meadow", to: "dist/themes" },
  ],
});
