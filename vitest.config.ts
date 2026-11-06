import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    // Tests spawn the real CLI and open SQLite files; forks keep native handles isolated.
    pool: "forks",
    testTimeout: 20_000,
  },
});
