import { describe, expect, test } from "vitest";
import { packageRoot } from "../../../scripts/third-party-notices.mjs";

// THIRD_PARTY_NOTICES.md lists the packages the bundle's files came from (PLAN.md §14).

describe("which package a bundled file came from", () => {
  test("a package and a scoped one, from pnpm's store, with either kind of slash", () => {
    expect(
      packageRoot("/repo/node_modules/.pnpm/hono@4.13.17/node_modules/hono/dist/index.js"),
    ).toBe("/repo/node_modules/.pnpm/hono@4.13.17/node_modules/hono");
    expect(
      packageRoot(
        "E:\\repo\\node_modules\\.pnpm\\@hono+node-server@2.1.6\\node_modules\\@hono\\node-server\\dist\\index.mjs",
      ),
    ).toBe("E:/repo/node_modules/.pnpm/@hono+node-server@2.1.6/node_modules/@hono/node-server");
  });

  test("none for Tend's own files or the bundler's", () => {
    expect(packageRoot("/repo/packages/tendcms/src/cli.ts")).toBeUndefined();
    expect(packageRoot("\0rolldown/runtime.js")).toBeUndefined();
  });
});
