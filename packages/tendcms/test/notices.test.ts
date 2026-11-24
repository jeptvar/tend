import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { noticeFor, packageRoot } from "../../../scripts/third-party-notices.mjs";
import { tempDir } from "./helpers.ts";

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

describe("a bundled package's licence", () => {
  function made(licence: unknown, file?: string): string {
    const root = tempDir();
    const manifest = { name: "some-package", version: "1.2.3", license: licence };
    writeFileSync(join(root, "package.json"), JSON.stringify(manifest));
    if (file !== undefined) writeFileSync(join(root, "LICENSE"), file);
    return root;
  }

  test("is the one in its folder", () => {
    const { name, text } = noticeFor(made("MIT", "MIT, as they wrote it"));
    expect(name).toBe("some-package");
    expect(text).toMatch(/^## some-package 1\.2\.3\n\nMIT/);
    expect(text).toContain("MIT, as they wrote it");
  });

  test("is the standard text of the one it names, if it has none of its own", () => {
    const { text } = noticeFor(made("Apache-2.0"));
    expect(text).toContain("TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION");
    expect(text).toContain("END OF TERMS AND CONDITIONS");
  });

  test.each([
    ["one there's no text for", "Some-Licence"],
    ["none", undefined],
    ["a path", "../third-party-notices"],
  ])("stops the build when it names %s and has no file", (_what, licence) => {
    expect(() => noticeFor(made(licence))).toThrow("has no licence file");
  });
});
