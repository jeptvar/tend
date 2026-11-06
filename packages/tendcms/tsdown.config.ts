import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/cli.ts"],
  platform: "node",
  target: "node24",
  dts: false,
  deps: {
    // Only the three native runtime dependencies stay external; pure-JS libraries
    // are devDependencies and get bundled (PLAN.md §7, P11). Anything else that
    // ends up in the bundle must be added here on purpose.
    neverBundle: ["better-sqlite3", "sharp", "@node-rs/argon2"],
    onlyBundle: ["hono", "@hono/node-server", "drizzle-orm", "zod"],
  },
  copy: [{ from: "../admin/dist", to: "dist", rename: "admin" }],
});
