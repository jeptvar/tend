import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { gunzipSync } from "node:zlib";
import { describe, expect, test, vi } from "vitest";
import { openDatabase, type SqliteDatabase } from "../src/db/client.ts";
import { MigrationError, migrate } from "../src/db/migrate.ts";
import { migrationsDir as realMigrationsDir } from "../src/paths.ts";
import { tempDir } from "./helpers.ts";

vi.mock("node:stream/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:stream/promises")>();
  return { ...actual, pipeline: vi.fn(actual.pipeline) };
});

const BASE = `
CREATE TABLE schema_meta (key text PRIMARY KEY NOT NULL, value text NOT NULL);
--> statement-breakpoint
CREATE TABLE parent (id integer PRIMARY KEY NOT NULL, name text NOT NULL);
--> statement-breakpoint
CREATE TABLE child (
  id integer PRIMARY KEY NOT NULL,
  parent_id integer NOT NULL REFERENCES parent(id) ON DELETE CASCADE
);`;

// What drizzle-kit generates for a SQLite column change, minus the PRAGMA lines
// that `pnpm db:generate` strips.
const REBUILD_PARENT = `
CREATE TABLE \`__new_parent\` (
  \`id\` integer PRIMARY KEY NOT NULL,
  \`name\` text NOT NULL,
  \`note\` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
INSERT INTO \`__new_parent\`("id", "name") SELECT "id", "name" FROM \`parent\`;--> statement-breakpoint
DROP TABLE \`parent\`;--> statement-breakpoint
ALTER TABLE \`__new_parent\` RENAME TO \`parent\`;`;

function setup(migrations: string[]) {
  const root = tempDir();
  const migrationsDir = join(root, "migrations");
  const backupsDir = join(root, "backups");
  mkdirSync(migrationsDir);
  mkdirSync(backupsDir);
  const add = (sql: string) => {
    const index = readdirSync(migrationsDir).length;
    writeFileSync(join(migrationsDir, `${String(index).padStart(4, "0")}_test.sql`), sql);
  };
  for (const sql of migrations) add(sql);
  const options = {
    dbPath: join(root, "tend.db"),
    backupsDir,
    migrationsDir,
    appVersion: "1.0.0",
    log: () => {},
  };
  return { root, options, add };
}

function withDb<T>(path: string, fn: (db: SqliteDatabase) => T): T {
  const db = openDatabase(path);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function count(path: string, table: string): number {
  return withDb(
    path,
    (db) => (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n,
  );
}

function meta(path: string, key: string): string | undefined {
  return withDb(
    path,
    (db) =>
      (
        db.prepare("SELECT value FROM schema_meta WHERE key = ?").get(key) as
          | { value: string }
          | undefined
      )?.value,
  );
}

function seedFamilies(path: string): void {
  withDb(path, (db) => {
    db.exec("INSERT INTO parent (id, name) VALUES (1, 'a'), (2, 'b')");
    db.exec("INSERT INTO child (id, parent_id) VALUES (1, 1), (2, 1), (3, 2)");
  });
}

describe("migrate", () => {
  test("applies the real migrations to a new database", async () => {
    const { options } = setup([]);
    const result = await migrate({ ...options, migrationsDir: realMigrationsDir });
    expect(result.applied.length).toBeGreaterThan(0);
    expect(result.snapshotPath).toBeUndefined();
    expect(meta(options.dbPath, "schema_version")).toBe(String(result.applied.length));
    expect(count(options.dbPath, "users")).toBe(0);
  });

  test("running migrations a second time changes nothing", async () => {
    const { options } = setup([]);
    const real = { ...options, migrationsDir: realMigrationsDir };
    await migrate(real);
    withDb(options.dbPath, (db) => {
      db.prepare(
        "INSERT INTO users (id, email, name, role, created_at) VALUES ('u1', 'a@example.com', 'A', 'admin', 1)",
      ).run();
    });
    const everything = () =>
      withDb(options.dbPath, (db) => ({
        schema: db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY name").all(),
        meta: db.prepare("SELECT * FROM schema_meta ORDER BY key").all(),
        users: db.prepare("SELECT * FROM users ORDER BY id").all(),
      }));
    const before = everything();

    const second = await migrate(real);
    expect(second.applied).toEqual([]);
    expect(second.snapshotPath).toBeUndefined();
    expect(everything()).toEqual(before);
    expect(before.users).toHaveLength(1);
    expect(readdirSync(options.backupsDir)).toEqual([]);
  });

  test("a table rebuild keeps the rows of a cascading child table", async () => {
    const { options, add } = setup([BASE]);
    await migrate(options);
    seedFamilies(options.dbPath);

    add(REBUILD_PARENT);
    let foreignKeysAfterCommit: unknown;
    const result = await migrate({
      ...options,
      afterCommit: (db) => {
        foreignKeysAfterCommit = db.pragma("foreign_keys", { simple: true });
      },
    });

    expect(result.applied).toEqual(["0001_test.sql"]);
    expect(foreignKeysAfterCommit).toBe(1);
    expect(count(options.dbPath, "parent")).toBe(2);
    expect(count(options.dbPath, "child")).toBe(3);
    expect(withDb(options.dbPath, (db) => db.pragma("foreign_key_check"))).toEqual([]);
    expect(result.snapshotPath && existsSync(result.snapshotPath)).toBe(true);
  });

  test("control: the same rebuild with foreign keys on does delete the child rows", async () => {
    // Proves the test above guards a real hazard rather than passing trivially.
    const { options } = setup([BASE]);
    await migrate(options);
    seedFamilies(options.dbPath);
    withDb(options.dbPath, (db) => {
      db.exec("BEGIN IMMEDIATE");
      db.exec(REBUILD_PARENT);
      db.exec("COMMIT");
    });
    expect(count(options.dbPath, "child")).toBe(0);
  });

  test("a failing migration rolls back everything pending", async () => {
    const { options, add } = setup([BASE]);
    await migrate(options);
    seedFamilies(options.dbPath);

    add("CREATE TABLE extra (id integer PRIMARY KEY);");
    add("THIS IS NOT SQL;");
    await expect(migrate(options)).rejects.toThrow();

    expect(meta(options.dbPath, "schema_version")).toBe("1");
    expect(
      withDb(options.dbPath, (db) =>
        db.prepare("SELECT name FROM sqlite_master WHERE name = 'extra'").get(),
      ),
    ).toBeUndefined();
    expect(count(options.dbPath, "child")).toBe(3);
  });

  test("a migration that leaves broken references is rolled back", async () => {
    const { options, add } = setup([BASE]);
    await migrate(options);
    seedFamilies(options.dbPath);

    add("INSERT INTO child (id, parent_id) VALUES (99, 404);");
    await expect(migrate(options)).rejects.toThrow(MigrationError);
    expect(meta(options.dbPath, "schema_version")).toBe("1");
    expect(count(options.dbPath, "child")).toBe(3);
  });

  test("a failure after COMMIT puts the site back", async () => {
    const { options, add } = setup([BASE]);
    await migrate(options);
    seedFamilies(options.dbPath);

    add("CREATE TABLE extra (id integer PRIMARY KEY);");
    await expect(
      migrate({
        ...options,
        afterCommit: () => {
          throw new Error("post-migration step failed");
        },
      }),
    ).rejects.toThrow(/put your site back the way it was/);

    expect(meta(options.dbPath, "schema_version")).toBe("1");
    expect(
      withDb(options.dbPath, (db) =>
        db.prepare("SELECT name FROM sqlite_master WHERE name = 'extra'").get(),
      ),
    ).toBeUndefined();
    expect(count(options.dbPath, "child")).toBe(3);
    expect(readdirSync(options.backupsDir)).toEqual([]);
  });

  test("says the truth and names the copy when putting the site back fails", async () => {
    const { options, add } = setup([BASE]);
    await migrate(options);
    add("CREATE TABLE extra (id integer PRIMARY KEY);");

    const error: Error = await migrate({
      ...options,
      afterCommit: () => {
        // Simulates a snapshot that can't be read back.
        const [name] = readdirSync(options.backupsDir);
        writeFileSync(join(options.backupsDir, name as string), "not gzip");
        throw new Error("post-migration step failed");
      },
    }).then(
      () => {
        throw new Error("expected migrate() to fail");
      },
      (reason) => reason,
    );

    expect(error).toBeInstanceOf(MigrationError);
    expect(error.message).toMatch(/was applied.*couldn't undo it/);
    expect(error.message).not.toMatch(/Nothing in your site changed/);
    const [name] = readdirSync(options.backupsDir);
    expect(error.message).toContain(name);
    expect(existsSync(`${options.dbPath}.restoring`)).toBe(false);
  });

  test("failed updates don't push out older snapshots", async () => {
    const { options, add } = setup([BASE]);
    await migrate(options);
    for (let i = 0; i < 3; i++) {
      add(`CREATE TABLE extra_${i} (id integer PRIMARY KEY);`);
      await migrate({ ...options, appVersion: `1.0.${i + 1}` });
    }
    const before = readdirSync(options.backupsDir).sort();
    expect(before).toHaveLength(3);

    add("THIS IS NOT SQL;");
    for (let i = 0; i < 4; i++) {
      await expect(migrate({ ...options, appVersion: "2.0.0" })).rejects.toThrow();
    }
    expect(readdirSync(options.backupsDir).sort()).toEqual(before);
  });

  test("a snapshot that fails partway never gets a real name", async () => {
    const { options, add } = setup([BASE]);
    await migrate(options);
    add("CREATE TABLE extra (id integer PRIMARY KEY);");

    // Writes part of the file wherever the code asked for it, then fails like a full disk.
    vi.mocked(pipeline).mockImplementationOnce((async (
      source: NodeJS.ReadableStream & { destroy(): void },
      _gzip: unknown,
      destination: NodeJS.WritableStream,
    ) => {
      source.destroy();
      await new Promise<void>((resolve) => destination.end("partial", () => resolve()));
      throw new Error("ENOSPC");
    }) as never);

    await expect(migrate(options)).rejects.toThrow("ENOSPC");
    expect(readdirSync(options.backupsDir)).toEqual([]);
    expect(meta(options.dbPath, "schema_version")).toBe("1");
  });

  test.runIf(process.platform !== "win32")(
    "snapshots and restores keep the database's file permissions",
    async () => {
      const { options, add } = setup([BASE]);
      await migrate(options);
      chmodSync(options.dbPath, 0o600);
      const mode = (path: string) => statSync(path).mode & 0o777;

      add("CREATE TABLE extra (id integer PRIMARY KEY);");
      const { snapshotPath } = await migrate(options);
      expect(mode(snapshotPath as string)).toBe(0o600);

      add("CREATE TABLE extra_2 (id integer PRIMARY KEY);");
      await expect(
        migrate({
          ...options,
          afterCommit: () => {
            throw new Error("post-migration step failed");
          },
        }),
      ).rejects.toThrow(/put your site back/);
      expect(mode(options.dbPath)).toBe(0o600);
    },
  );

  test("an update always keeps the snapshot it just took, whatever the clock said before", async () => {
    const { options, add } = setup([BASE]);
    await migrate(options);
    const future = (year: number) => `pre-1.0.0-from-0.9.0-${year}0101T000000.000Z.db.gz`;
    for (const year of [2097, 2098, 2099]) {
      writeFileSync(join(options.backupsDir, future(year)), "x");
    }

    add("CREATE TABLE extra (id integer PRIMARY KEY);");
    const { snapshotPath } = await migrate(options);

    expect(existsSync(snapshotPath as string)).toBe(true);
    expect(readdirSync(options.backupsDir).sort()).toEqual(
      [future(2098), future(2099), basename(snapshotPath as string)].sort(),
    );
  });

  test("removes what an interrupted snapshot or restore left behind", async () => {
    const { options, add } = setup([BASE]);
    await migrate(options);
    const leftovers = [".tmp-pre-x.db.gz.raw", ".tmp-pre-x.db.gz.raw-journal", ".tmp-pre-x.db.gz"];
    for (const name of leftovers) writeFileSync(join(options.backupsDir, name), "partial");
    writeFileSync(`${options.dbPath}.restoring`, "partial");

    add("CREATE TABLE extra (id integer PRIMARY KEY);");
    const { snapshotPath } = await migrate(options);

    expect(readdirSync(options.backupsDir)).toEqual([basename(snapshotPath as string)]);
    expect(existsSync(`${options.dbPath}.restoring`)).toBe(false);
  });

  test("won't apply on top of an update that happened during the snapshot", async () => {
    const { options, add } = setup([BASE]);
    await migrate(options);
    add("INSERT INTO parent (id, name) VALUES (7, 'once');");

    await expect(
      migrate({
        ...options,
        // The snapshot is the slow step, so it's when another process could get in.
        log: (message) => {
          if (!message.startsWith("Saved a copy")) return;
          withDb(options.dbPath, (db) =>
            db.exec("UPDATE schema_meta SET value = '2' WHERE key = 'schema_version'"),
          );
        },
      }),
    ).rejects.toThrow(/Another copy of Tend updated the database/);

    expect(count(options.dbPath, "parent")).toBe(0);
  });

  test("refuses a database saved by a newer version", async () => {
    const { options } = setup([BASE]);
    await migrate(options);
    withDb(options.dbPath, (db) => {
      db.exec("UPDATE schema_meta SET value = '9' WHERE key = 'schema_version'");
      db.exec("UPDATE schema_meta SET value = '2.0.0' WHERE key = 'min_app_version'");
    });
    await expect(migrate(options)).rejects.toThrow(/saved by Tend 2\.0\.0, which is newer/);
  });

  test("keeps only the three newest pre-update snapshots", async () => {
    const { options, add } = setup([BASE]);
    await migrate(options);
    for (let i = 0; i < 4; i++) {
      add(`CREATE TABLE extra_${i} (id integer PRIMARY KEY);`);
      await migrate({ ...options, appVersion: `1.0.${i + 1}` });
    }
    const snapshots = readdirSync(options.backupsDir);
    expect(snapshots).toHaveLength(3);
    expect(snapshots.every((name) => name.startsWith("pre-") && name.endsWith(".db.gz"))).toBe(
      true,
    );
    expect(snapshots.some((name) => name.startsWith("pre-1.0.1-"))).toBe(false);
  });

  test("snapshot age comes from the name, so copying the folder can't change what's kept", async () => {
    const { options, add } = setup([BASE]);
    await migrate(options);
    const stamped = (minute: number) =>
      `pre-1.0.0-from-0.9.0-20260101T00${String(minute).padStart(2, "0")}00.000Z.db.gz`;
    // Written oldest-name-last, so file times and readdir order both point the wrong way.
    for (const minute of [3, 2, 1]) writeFileSync(join(options.backupsDir, stamped(minute)), "x");

    add("CREATE TABLE extra (id integer PRIMARY KEY);");
    const { snapshotPath } = await migrate(options);

    expect(readdirSync(options.backupsDir).sort()).toEqual(
      [stamped(2), stamped(3), basename(snapshotPath as string)].sort(),
    );
  });

  test("a restored snapshot is a working database", async () => {
    const { root, options, add } = setup([BASE]);
    await migrate(options);
    seedFamilies(options.dbPath);
    add("CREATE TABLE extra (id integer PRIMARY KEY);");
    const { snapshotPath } = await migrate(options);

    const restored = join(root, "restored.db");
    writeFileSync(restored, gunzipSync(readFileSync(snapshotPath as string)));
    expect(count(restored, "child")).toBe(3);
    expect(meta(restored, "schema_version")).toBe("1");
  });
});
