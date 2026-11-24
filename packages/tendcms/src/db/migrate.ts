import {
  createReadStream,
  createWriteStream,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import Database from "better-sqlite3";
import { fsyncDir, fsyncFile } from "../durable.ts";
import { PlainError } from "../plain-error.ts";
import { openDatabase, type SqliteDatabase } from "./client.ts";

export interface MigrateOptions {
  dbPath: string;
  backupsDir: string;
  migrationsDir: string;
  appVersion: string;
  log?: (message: string) => void;
  /** Runs after COMMIT. If it throws, the pre-migration snapshot is restored. */
  afterCommit?: (db: SqliteDatabase) => void;
}

export interface MigrateResult {
  applied: string[];
  schemaVersion: number;
  snapshotPath: string | undefined;
}

export class MigrationError extends PlainError {}

const SNAPSHOTS_KEPT = 3;
/** Work in the backups folder that isn't finished yet. Anything named so is removed at boot. */
export const SNAPSHOT_TMP_PREFIX = ".tmp-";

/**
 * Brings tend.db up to date (PLAN.md §13):
 * snapshot outside any transaction, foreign keys off *before* BEGIN IMMEDIATE so
 * table rebuilds can't cascade-delete child rows, every pending migration in one
 * transaction, an empty foreign_key_check before COMMIT, and an automatic
 * restore if anything fails after COMMIT. The caller holds the process lock.
 */
export async function migrate(options: MigrateOptions): Promise<MigrateResult> {
  const log = options.log ?? console.log;
  const files = readdirSync(options.migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  removeInterruptedWork(options);

  const db = openDatabase(options.dbPath);
  try {
    const current = readSchemaVersion(db);
    if (current > files.length) {
      const needs = readMeta(db, "min_app_version") ?? "a newer version";
      throw new MigrationError(
        `This site's data was saved by Tend ${needs}, which is newer than this copy (${options.appVersion}). ` +
          "Install that version again, or restore a backup made with this version.",
      );
    }

    const pending = files.slice(current);
    if (pending.length === 0) {
      writeMeta(db, { app_version_last_run: options.appVersion });
      return { applied: [], schemaVersion: current, snapshotPath: undefined };
    }

    const snapshotPath =
      current > 0
        ? await takeSnapshot(db, options, readMeta(db, "app_version_last_run") ?? "unknown")
        : undefined;
    if (snapshotPath) log(`Saved a copy of your site before updating: ${snapshotPath}`);

    const schemaVersion = current + pending.length;
    try {
      applyInOneTransaction(db, options, pending, current);
    } catch (error) {
      // Nothing changed, so this copy is identical to the database. Keeping it would
      // pile up a full-size file every time a bad release restarts in a loop.
      if (snapshotPath) rmSync(snapshotPath, { force: true });
      throw error;
    }

    try {
      const check = db.pragma("quick_check", { simple: true });
      if (check !== "ok")
        throw new MigrationError(`The database check after updating failed: ${check}`);
      options.afterCommit?.(db);
    } catch (error) {
      if (!snapshotPath) throw error;
      db.close();
      await putBackSnapshot(snapshotPath, options.dbPath, error);
      throw new MigrationError(
        "The update stopped, so Tend put your site back the way it was. Nothing in your site changed.",
        { cause: error },
      );
    }

    // Only now: older copies must survive any number of failed updates.
    if (snapshotPath) pruneSnapshots(options.backupsDir, snapshotPath, log);
    // A brand new site has nothing to report: it wasn't updated from anything.
    if (current > 0) log(`Updated the database to version ${schemaVersion}.`);
    return { applied: pending, schemaVersion, snapshotPath };
  } finally {
    db.close();
  }
}

/** True when a database is fully updated, for commands that run beside the server. */
export function schemaIsCurrent(db: SqliteDatabase, migrationsDir: string): boolean {
  const files = readdirSync(migrationsDir).filter((file) => file.endsWith(".sql"));
  return readSchemaVersion(db) === files.length;
}

function applyInOneTransaction(
  db: SqliteDatabase,
  options: MigrateOptions,
  pending: string[],
  current: number,
): void {
  // PRAGMA foreign_keys is a no-op inside a transaction, so it must happen first.
  db.pragma("foreign_keys = OFF");
  if (db.pragma("foreign_keys", { simple: true }) !== 0) {
    throw new MigrationError("Could not turn off foreign keys before updating the database.");
  }
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      // `current` was read before the snapshot, which can take a while. Applying the
      // same files on top of someone else's update would run data changes twice.
      if (readSchemaVersion(db) !== current) {
        throw new MigrationError(
          "Another copy of Tend updated the database while this one was starting. Start Tend again.",
        );
      }
      for (const file of pending) {
        db.exec(readFileSync(join(options.migrationsDir, file), "utf8"));
      }
      const violations = db.pragma("foreign_key_check") as unknown[];
      if (violations.length > 0) {
        throw new MigrationError(
          `The update would leave ${violations.length} rows pointing at rows that don't exist, so nothing was changed.`,
        );
      }
      writeMeta(db, {
        schema_version: String(current + pending.length),
        app_version_last_run: options.appVersion,
        min_app_version: options.appVersion,
      });
      db.exec("COMMIT");
    } catch (error) {
      if (db.inTransaction) db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.pragma("foreign_keys = ON");
  }
}

function hasSchemaMeta(db: SqliteDatabase): boolean {
  return (
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta'")
      .get() !== undefined
  );
}

function readMeta(db: SqliteDatabase, key: string): string | undefined {
  if (!hasSchemaMeta(db)) return undefined;
  const row = db.prepare("SELECT value FROM schema_meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function readSchemaVersion(db: SqliteDatabase): number {
  return Number(readMeta(db, "schema_version") ?? 0);
}

function writeMeta(db: SqliteDatabase, values: Record<string, string>): void {
  const upsert = db.prepare(
    "INSERT INTO schema_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  );
  for (const [key, value] of Object.entries(values)) upsert.run(key, value);
}

async function takeSnapshot(
  db: SqliteDatabase,
  options: MigrateOptions,
  fromVersion: string,
): Promise<string> {
  const stamp = new Date().toISOString().replace(/[-:]/g, "");
  const name = `pre-${options.appVersion}-from-${fromVersion}-${stamp}.db.gz`;
  return saveSnapshot(db, options.dbPath, options.backupsDir, name);
}

/**
 * Saves a gzipped copy of the database in the backups folder as `name`, made with SQLite's
 * backup API outside any transaction, so the site can keep running while it's made. With
 * `check`, the copy must pass quick_check first, as the automatic daily ones must.
 */
export async function saveSnapshot(
  db: SqliteDatabase,
  dbPath: string,
  backupsDir: string,
  name: string,
  options: { check?: boolean } = {},
): Promise<string> {
  const finalPath = join(backupsDir, name);
  const rawTmp = join(backupsDir, `${SNAPSHOT_TMP_PREFIX}${name}.raw`);
  const gzTmp = join(backupsDir, `${SNAPSHOT_TMP_PREFIX}${name}`);

  // Copies hold the same private data, so they get the same protection as the database.
  const mode = fileMode(dbPath);

  // Only a finished, flushed file gets a real name, so a snapshot that was cut short
  // can't be mistaken for a good one or push a good one out.
  try {
    writeFileSync(rawTmp, "", { mode });
    await db.backup(rawTmp);
    if (options.check) quickCheck(rawTmp);
    await pipeline(createReadStream(rawTmp), createGzip(), createWriteStream(gzTmp, { mode }));
    fsyncFile(gzTmp);
    renameSync(gzTmp, finalPath);
    fsyncDir(backupsDir);
  } finally {
    // The copy is in WAL mode like the database, so checking it leaves a -wal and -shm.
    for (const path of [rawTmp, `${rawTmp}-journal`, `${rawTmp}-wal`, `${rawTmp}-shm`, gzTmp]) {
      rmSync(path, { force: true });
    }
  }
  return finalPath;
}

/** Throws unless a copy of the database passes quick_check. */
export function quickCheck(path: string): void {
  const copy = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const result = copy.pragma("quick_check", { simple: true });
    if (result !== "ok") throw new Error(`The copy of the site's data failed its check: ${result}`);
  } finally {
    copy.close();
  }
}

function fileMode(path: string): number {
  return statSync(path).mode & 0o777;
}

function removeInterruptedWork(options: MigrateOptions): void {
  rmSync(`${options.dbPath}.restoring`, { force: true });
  for (const file of readdirSync(options.backupsDir)) {
    if (file.startsWith(SNAPSHOT_TMP_PREFIX)) {
      // Folders too: a restore unpacks a backup into one before it's checked.
      rmSync(join(options.backupsDir, file), { recursive: true, force: true });
    }
  }
}

/**
 * Keeps the snapshot just taken plus the newest others, going by the time in their
 * names: file times don't survive a copy. The new one is always kept, because a
 * clock that was once ahead could make it look like the oldest.
 */
function pruneSnapshots(
  backupsDir: string,
  justTaken: string,
  log: (message: string) => void,
): void {
  const stampOf = (name: string) => name.match(/-(\d{8}T\d{6}\.\d{3}Z)\.db\.gz$/)?.[1] ?? "";
  try {
    const old = readdirSync(backupsDir)
      .filter((file) => file.startsWith("pre-") && file.endsWith(".db.gz"))
      .filter((file) => file !== basename(justTaken))
      .sort((a, b) => stampOf(b).localeCompare(stampOf(a)) || b.localeCompare(a))
      .slice(SNAPSHOTS_KEPT - 1);
    for (const file of old) rmSync(join(backupsDir, file), { force: true });
  } catch (error) {
    // The update already succeeded; an extra old copy is harmless.
    log(`Couldn't remove old copies from ${backupsDir}: ${(error as Error).message}`);
  }
}

async function putBackSnapshot(
  snapshotPath: string,
  dbPath: string,
  updateError: unknown,
): Promise<void> {
  const tmpPath = `${dbPath}.restoring`;
  try {
    const mode = fileMode(dbPath);
    await pipeline(
      createReadStream(snapshotPath),
      createGunzip(),
      createWriteStream(tmpPath, { mode }),
    );
    fsyncFile(tmpPath);
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    renameSync(tmpPath, dbPath);
  } catch (error) {
    rmSync(tmpPath, { force: true });
    throw new MigrationError(
      "The update was applied but a check after it failed, and Tend couldn't undo it. " +
        `Your site as it was before is saved in ${snapshotPath}. Restore it: https://tendcms.dev/errors/restore_failed`,
      { cause: new AggregateError([updateError, error]) },
    );
  }
  // The database is back to this copy, so keeping it too would only use up disk.
  rmSync(snapshotPath, { force: true });
}
