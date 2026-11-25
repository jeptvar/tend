import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import { rerenderPublished } from "../src/content/rerender.ts";
import { openDatabase } from "../src/db/client.ts";
import { migrate, schemaIsCurrent } from "../src/db/migrate.ts";
import { migrationsDir } from "../src/paths.ts";
import { browser, makeApp } from "./auth-helpers.ts";
import { tempDir } from "./helpers.ts";

// A site from each version released so far, brought up to date (PLAN.md §15). Nothing in it may
// be lost, and the API and its pages still say everything they said. scripts/make-fixture.mjs
// makes one at each release.

const FIXTURES = join(import.meta.dirname, "..", "..", "..", "fixtures", "upgrades");
const VERSIONS = readdirSync(FIXTURES)
  .filter((name) => name.endsWith(".db.gz"))
  .map((name) => name.replace(/\.db\.gz$/, ""));

interface Fixture {
  version: string;
  madeAt: number;
  owner: { email: string; password: string };
  /** How many rows each table had. */
  rows: Record<string, number>;
  /** What the admin API answered, by address. */
  api: Record<string, unknown>;
  /** The words on each page, by address. */
  pages: Record<string, string[]>;
  /** Where each redirect went. */
  leadsTo: Record<string, string>;
}

/** The site as that version left it, in a data folder of its own. */
function unpack(version: string): { root: string; dbPath: string; fixture: Fixture } {
  const read = (name: string) => gunzipSync(readFileSync(join(FIXTURES, name)));
  const root = tempDir();
  const dbPath = join(root, "tend.db");
  mkdirSync(join(root, "backups"));
  writeFileSync(dbPath, read(`${version}.db.gz`));
  return { root, dbPath, fixture: JSON.parse(read(`${version}.json.gz`).toString()) };
}

function upgrade(root: string, dbPath: string): Promise<unknown> {
  const backupsDir = join(root, "backups");
  return migrate({ dbPath, backupsDir, migrationsDir, appVersion: "999.0.0", log: () => {} });
}

/** How a page writes words, so that they can be looked for in it. */
function inPage(words: string): string {
  return words
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

test("there's a site from at least one version", () => {
  expect(VERSIONS.length).toBeGreaterThan(0);
});

describe.each(VERSIONS)("a site from %s", (version) => {
  test("keeps every row, with nothing pointing at what isn't there", async () => {
    const { root, dbPath, fixture } = unpack(version);
    await upgrade(root, dbPath);
    const db = openDatabase(dbPath);
    try {
      expect(schemaIsCurrent(db, migrationsDir)).toBe(true);
      const now = Object.fromEntries(
        Object.keys(fixture.rows).map((table) => [
          table,
          db.prepare(`SELECT count(*) FROM "${table}"`).pluck().get(),
        ]),
      );
      // schema_meta holds what Tend notes about itself, which a newer one adds to.
      const { schema_meta: meta, ...rows } = fixture.rows;
      expect(now).toMatchObject(rows);
      expect(now.schema_meta).toBeGreaterThanOrEqual(meta as number);
      expect(db.pragma("foreign_key_check")).toEqual([]);
      expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    } finally {
      db.close();
    }
  });

  test("says everything it said, to the admin and to visitors", async () => {
    const { root, dbPath, fixture } = unpack(version);
    await upgrade(root, dbPath);
    // The day it was made, so that its invites still work.
    const made = await makeApp({ now: () => fixture.madeAt }, { root });
    await rerenderPublished(made.orm);
    const owner = browser(made.app);
    const signedIn = await owner.post("/api/auth/login", fixture.owner);
    expect(signedIn.status).toBe(200);

    for (const [path, said] of Object.entries(fixture.api)) {
      const reply = await owner.get(`/api/admin${path}`);
      expect(reply.status, path).toBe(200);
      expect(await reply.json(), path).toMatchObject(said as object);
    }
    for (const [path, words] of Object.entries(fixture.pages)) {
      const reply = await made.app.request(path);
      expect(reply.status, path).toBe(200);
      const html = await reply.text();
      for (const part of words) expect(html, path).toContain(inPage(part.trim()));
    }
    for (const [from, to] of Object.entries(fixture.leadsTo)) {
      const reply = await made.app.request(from);
      expect(reply.status, from).toBe(301);
      expect(reply.headers.get("location"), from).toBe(to);
    }
  });
});
