import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  businessSchema,
  codeSchema,
  designSchema,
  generalSchema,
  seoSchema,
  visibilitySchema,
} from "../src/content/settings.ts";
import { defaultThemeDir } from "../src/paths.ts";
import { makeApp } from "./auth-helpers.ts";

// How much there is of Tend (PLAN.md §4, P11). Each of these is a limit for v0.1: a change that
// goes over one has to take something away, or make the case in the plan.

const MANIFEST = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"));
const RUNTIME = ["@node-rs/argon2", "better-sqlite3", "sharp"];

describe("the complexity budget", () => {
  test("the database has at most 14 tables", async () => {
    const { db } = await makeApp();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .pluck()
      .all();
    expect(tables.length).toBeGreaterThan(5);
    expect(tables.length, (tables as string[]).join(", ")).toBeLessThanOrEqual(14);
  });

  test("installing Tend brings 3 packages of its own choosing, pinned exactly", () => {
    expect(Object.keys(MANIFEST.dependencies).sort()).toEqual(RUNTIME);
    for (const version of Object.values(MANIFEST.dependencies)) {
      expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    }
    expect(MANIFEST.optionalDependencies).toBeUndefined();
    expect(MANIFEST.peerDependencies).toBeUndefined();
  });

  test("it's made from at most 20 packages, Tend's own admin aside", () => {
    const all = [
      ...Object.keys(MANIFEST.dependencies),
      ...Object.keys(MANIFEST.devDependencies).filter((name) => !name.startsWith("@tendcms/")),
    ];
    expect(all.length, all.join(", ")).toBeLessThanOrEqual(20);
  });

  test("create-tend brings none", () => {
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dirname, "..", "..", "create-tend", "package.json"), "utf8"),
    );
    expect(manifest.dependencies).toBeUndefined();
    expect(manifest.optionalDependencies).toBeUndefined();
  });

  test("Settings and Design have at most 32 fields", () => {
    const theme = JSON.parse(readFileSync(join(defaultThemeDir, "theme.json"), "utf8"));
    const fields = [
      ...[generalSchema, visibilitySchema, businessSchema, seoSchema, codeSchema].flatMap(
        (schema) => Object.keys(schema.shape),
      ),
      // The site's address, and a redirect's two.
      "address",
      "from",
      "to",
      // The theme's own choices are kept together in one.
      ...Object.keys(designSchema.shape).filter((name) => name !== "theme"),
      ...theme.settings.map(({ id }: { id: string }) => id),
    ];
    expect(fields.length).toBeGreaterThan(20);
    expect(fields.length, fields.join(", ")).toBeLessThanOrEqual(32);
  });
});
