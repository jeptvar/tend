import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { tempDir } from "./helpers.ts";

const script = join(import.meta.dirname, "..", "..", "..", "scripts", "lint-migrations.mjs");

function lint(dir?: string) {
  return spawnSync(process.execPath, dir ? [script, dir] : [script], { encoding: "utf8" });
}

describe("migration lint", () => {
  test("passes on the real migrations", () => {
    expect(lint().status).toBe(0);
  });

  test("passes on clean files", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "0000_a.sql"), "CREATE TABLE a (id integer);");
    expect(lint(dir).status).toBe(0);
  });

  test("fails on a PRAGMA and names the line", () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, "0000_a.sql"),
      "CREATE TABLE a (id integer);\npragma foreign_keys=OFF;",
    );
    const result = lint(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("0000_a.sql:2");
  });

  test("fails rather than passing when there's nothing to check", () => {
    const empty = tempDir();
    expect(lint(empty).status).toBe(1);
    const missing = join(tempDir(), "moved");
    expect(lint(missing).status).toBe(1);
    mkdirSync(missing);
    expect(lint(missing).status).toBe(1);
  });
});
