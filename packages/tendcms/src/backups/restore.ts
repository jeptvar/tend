import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statfsSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, gunzipSync } from "node:zlib";
import Database from "better-sqlite3";
import { Unzip, UnzipInflate } from "fflate";
import { parseSecretKey, SECRET_KEY_BYTES, secretKeyText } from "../config.ts";
import { openDatabase, type SqliteDatabase } from "../db/client.ts";
import { isDamage } from "../db/damage.ts";
import { migrate, readSchemaVersion, saveSnapshot } from "../db/migrate.ts";
import { fsyncDir, fsyncFile } from "../durable.ts";
import { PlainError } from "../plain-error.ts";
import {
  BACKUP_FORMAT,
  type BackupFile,
  type BackupManifest,
  DATABASE_ENTRY,
  isBackupEntry,
  KEY_ENTRY,
  MANIFEST_ENTRY,
  ORIGINALS_PREFIX,
} from "./format.ts";

/** Why a backup can't be restored, in words for whoever is restoring it. */
export class BackupError extends PlainError {}

export interface CheckedBackup {
  manifest: BackupManifest;
  /** The key the site was saved with. */
  key: Buffer;
  /** Where it was unpacked, every file checked. */
  folder: string;
}

export interface RestoreTarget {
  dataDir: string;
  dbPath: string;
  backupsDir: string;
  uploadsDir: string;
  secretKeyPath: string;
}

/** More files than any site has: a backup holding more is refused before they fill the disk. */
const MAX_ENTRIES = 200_000;
const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;
const MAX_KEY_BYTES = 1024;

const NOT_A_BACKUP =
  "This file isn't a Tend backup, or it's damaged. Download a new backup from the site and try that.";
const NO_ROOM =
  "There isn't enough free space here to restore this backup. Free some space, then try again.";
const DAMAGED =
  "The site's data in this backup is damaged, so it wasn't used. Download a new backup from the site and try that.";

/**
 * Unpacks a backup into `folder` and checks all of it before anything is restored
 * (PLAN.md §12): only the names a backup can hold, each file's SHA-256 against the
 * manifest, nothing missing or extra, a key Tend can start with, and a database that passes
 * integrity_check, opened with trusted_schema off, from a Tend no newer than this one. It
 * never takes more than 90% of the free space, so a zip that unpacks to far more than it
 * says stops early.
 */
export async function checkBackup(
  zipPath: string,
  folder: string,
  newestSchema: number,
): Promise<CheckedBackup> {
  mkdirSync(folder, { recursive: true });
  const room = Math.floor(freeSpace(folder) * 0.9);
  const found = new Map<string, BackupFile>();
  const started = new Set<string>();
  const openFiles = new Set<number>();
  const manifestParts: Buffer[] = [];
  let unpacked = 0;
  let problem: Error | undefined;
  const refuse = (message: string) => {
    problem ??= new BackupError(message);
  };

  const unzip = new Unzip((entry) => {
    if (problem) return;
    const name = entry.name;
    if (!isBackupEntry(name)) {
      refuse(
        `This backup holds a file Tend doesn't expect, ${JSON.stringify(name)}, so it wasn't used.`,
      );
      return;
    }
    if (started.has(name)) {
      refuse(`This backup holds ${name} twice, so it wasn't used.`);
      return;
    }
    if (started.size >= MAX_ENTRIES) {
      refuse(NOT_A_BACKUP);
      return;
    }
    started.add(name);
    let fd: number | undefined;
    if (name !== MANIFEST_ENTRY) {
      const path = join(folder, name);
      mkdirSync(dirname(path), { recursive: true });
      fd = openSync(path, "wx", 0o600);
      openFiles.add(fd);
    }
    const hash = createHash("sha256");
    let bytes = 0;
    entry.ondata = (error, chunk, final) => {
      if (problem) return;
      if (error) {
        refuse(NOT_A_BACKUP);
        return;
      }
      bytes += chunk.length;
      unpacked += chunk.length;
      if (unpacked > room) {
        refuse(NO_ROOM);
        return;
      }
      hash.update(chunk);
      try {
        if (fd === undefined) {
          if (bytes > MAX_MANIFEST_BYTES) throw new BackupError(NOT_A_BACKUP);
          manifestParts.push(Buffer.from(chunk));
        } else {
          writeSync(fd, chunk);
        }
        if (final) {
          if (fd !== undefined) {
            fsyncSync(fd);
            closeSync(fd);
            openFiles.delete(fd);
          }
          found.set(name, { path: name, bytes, sha256: hash.digest("hex") });
        }
      } catch (writeError) {
        problem ??= writeError as Error;
      }
    };
    entry.start();
  });
  unzip.register(UnzipInflate);

  try {
    for await (const chunk of createReadStream(zipPath, { highWaterMark: 64 * 1024 })) {
      unzip.push(chunk);
      if (problem) break;
    }
    if (!problem) unzip.push(new Uint8Array(0), true);
  } catch (error) {
    // fflate throws on bytes that aren't a zip; a full disk throws with a code of its own.
    problem ??= (error as NodeJS.ErrnoException).code
      ? (error as Error)
      : new BackupError(NOT_A_BACKUP);
  } finally {
    for (const fd of openFiles) closeSync(fd);
  }
  if (problem) throw problem;

  const manifest = readManifest(Buffer.concat(manifestParts), found);
  if ((found.get(KEY_ENTRY)?.bytes ?? 0) > MAX_KEY_BYTES) throw new BackupError(NOT_A_BACKUP);
  const key = keyIn(readFileSync(join(folder, KEY_ENTRY)));
  checkDatabase(join(folder, DATABASE_ENTRY), manifest, newestSchema);
  return { manifest, key, folder };
}

/** Whether a file is one of the copies kept on the server, rather than a backup zip. */
export function isCopy(path: string): boolean {
  const start = Buffer.alloc(2);
  const fd = openSync(path, "r");
  try {
    readSync(fd, start, 0, 2, 0);
  } finally {
    closeSync(fd);
  }
  return start[0] === 0x1f && start[1] === 0x8b;
}

/**
 * Unpacks and checks one of the copies Tend keeps (tend.db, gzipped), as checkBackup does a
 * backup. It has no key and no uploads in it. The site's own key stays, or the one kept beside
 * a copy saved before a restore comes back with it.
 */
export async function checkCopy(
  copyPath: string,
  folder: string,
  newestSchema: number,
  target: Pick<RestoreTarget, "secretKeyPath">,
): Promise<CheckedBackup & { newKey: boolean }> {
  mkdirSync(folder, { recursive: true });
  const path = join(folder, DATABASE_ENTRY);
  let room = Math.floor(freeSpace(folder) * 0.9);
  const limit = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      room -= chunk.length;
      if (room >= 0) done(null, chunk);
      else done(new BackupError(NO_ROOM));
    },
  });
  try {
    await pipeline(
      createReadStream(copyPath),
      createGunzip(),
      limit,
      createWriteStream(path, { mode: 0o600 }),
    );
  } catch (error) {
    const { code = "" } = error as NodeJS.ErrnoException;
    // zlib's own complaints about what it's given: anything else is the disk's.
    throw code.startsWith("Z_") || code === "ERR_STREAM_PREMATURE_CLOSE"
      ? new BackupError(NOT_A_BACKUP)
      : error;
  }
  const schemaVersion = schemaIn(path);
  checkDatabase(path, { schemaVersion, appVersion: "a newer version" }, newestSchema);
  const beside = copyPath.replace(/\.db\.gz$/, ".secret.key");
  const kept = [beside, target.secretKeyPath]
    .filter((each) => each !== copyPath && existsSync(each))
    .map((each) => parseSecretKey(readFileSync(each)))
    .find((key) => key !== undefined);
  return {
    manifest: {
      format: BACKUP_FORMAT,
      createdAt: new Date().toISOString(),
      appVersion: "",
      schemaVersion,
      site: "",
      files: [],
    },
    key: kept ?? randomBytes(SECRET_KEY_BYTES),
    newKey: kept === undefined,
    folder,
  };
}

/** The schema version of an unpacked database, which nothing in it may run to say. */
function schemaIn(path: string): number {
  let db: Database.Database | undefined;
  try {
    db = new Database(path, { readonly: true, fileMustExist: true });
    db.pragma("trusted_schema = OFF");
    const version = readSchemaVersion(db);
    if (version < 1) throw new BackupError(NOT_A_BACKUP);
    return version;
  } catch (error) {
    if (error instanceof BackupError) throw error;
    throw new BackupError(NOT_A_BACKUP);
  } finally {
    db?.close();
  }
}

/** The key a backup holds. The first ones, before Tend had a release, held only its bytes. */
function keyIn(contents: Buffer): Buffer {
  const bytes = contents.length === SECRET_KEY_BYTES ? contents : undefined;
  const key = parseSecretKey(contents) ?? bytes;
  if (!key) throw new BackupError(NOT_A_BACKUP);
  return key;
}

/** Puts a key in place of the one a site has, in one step, as Tend reads it when it starts. */
function replaceKey(path: string, key: Buffer): void {
  const tmpPath = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmpPath, secretKeyText(key), { mode: 0o600 });
    fsyncFile(tmpPath);
    renameSync(tmpPath, path);
  } catch (error) {
    rmSync(tmpPath, { force: true });
    throw error;
  }
}

function readManifest(text: Buffer, found: Map<string, BackupFile>): BackupManifest {
  if (!found.has(MANIFEST_ENTRY)) throw new BackupError(NOT_A_BACKUP);
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(text.toString("utf8"));
  } catch {
    throw new BackupError(NOT_A_BACKUP);
  }
  if (typeof manifest?.format === "number" && manifest.format > BACKUP_FORMAT) {
    throw new BackupError(
      `This backup was made by a newer Tend (${manifest.appVersion}). Update Tend, then restore it.`,
    );
  }
  if (
    manifest?.format !== BACKUP_FORMAT ||
    !Array.isArray(manifest.files) ||
    !Number.isInteger(manifest.schemaVersion)
  ) {
    throw new BackupError(NOT_A_BACKUP);
  }
  const listed = new Map(manifest.files.map((file) => [file.path, file]));
  if (listed.size !== manifest.files.length) throw new BackupError(NOT_A_BACKUP);
  for (const [name, file] of found) {
    if (name === MANIFEST_ENTRY) continue;
    const said = listed.get(name);
    if (!said || said.bytes !== file.bytes || said.sha256 !== file.sha256) {
      throw new BackupError(
        `${name} in this backup isn't the file that was saved: it was changed or damaged since. The backup wasn't used.`,
      );
    }
  }
  for (const name of listed.keys()) {
    if (!found.has(name)) {
      throw new BackupError(`This backup is missing ${name}, so it may have been cut short.`);
    }
  }
  if (!listed.has(DATABASE_ENTRY) || !listed.has(KEY_ENTRY)) throw new BackupError(NOT_A_BACKUP);
  return manifest;
}

function checkDatabase(
  path: string,
  manifest: Pick<BackupManifest, "schemaVersion" | "appVersion">,
  newestSchema: number,
): void {
  if (manifest.schemaVersion > newestSchema) {
    throw new BackupError(
      `This backup was made by a newer Tend (${manifest.appVersion}). Update Tend to that version or later, then restore it.`,
    );
  }
  let db: Database.Database | undefined;
  try {
    db = new Database(path, { readonly: true, fileMustExist: true });
    // Before anything reads the schema, so nothing in it can run.
    db.pragma("trusted_schema = OFF");
    if (db.pragma("integrity_check", { simple: true }) !== "ok") throw new BackupError(DAMAGED);
    if (readSchemaVersion(db) !== manifest.schemaVersion) throw new BackupError(DAMAGED);
  } catch (error) {
    if (error instanceof BackupError) throw error;
    throw new BackupError(DAMAGED);
  } finally {
    db?.close();
  }
}

/**
 * Puts a checked backup in place of the site in the data folder. Whoever calls it holds the
 * data folder's lock, and nothing else has the database open. The site as it was is saved
 * first, as before-restore-<time>.db.gz in the backups folder, with its key beside it as
 * before-restore-<time>.secret.key if the backup has another, so a restore can be undone. A
 * database too damaged for that is kept as it is, since it may be why this is being done.
 * Originals go in first; they're named by their content, so one already there is the same
 * file. Then the key and the database, each by a rename, so neither is ever half there.
 */
export async function restoreBackup(
  checked: CheckedBackup,
  target: RestoreTarget,
  now = new Date(),
): Promise<{ snapshotPath: string | undefined; wasDamaged: boolean }> {
  let snapshotPath: string | undefined;
  let wasDamaged = false;
  if (existsSync(target.dbPath)) {
    const name = `before-restore-${now.toISOString().replace(/[-:]/g, "")}`;
    try {
      checkReadable(target.dbPath);
      snapshotPath = await saveDatabase(target, `${name}.db.gz`);
    } catch (error) {
      if (!isDamage(error)) throw error;
      wasDamaged = true;
      snapshotPath = keepDamaged(target, `${name}-damaged.db`);
    }
    keepKey(target, checked.key, `${name}.secret.key`);
  }

  moveOriginals(checked, target.uploadsDir);
  replaceKey(target.secretKeyPath, checked.key);
  // The site that was here may have left changes in its WAL. They belong to that database.
  for (const leftover of [`${target.dbPath}-wal`, `${target.dbPath}-shm`]) {
    rmSync(leftover, { force: true });
  }
  renameSync(join(checked.folder, DATABASE_ENTRY), target.dbPath);
  fsyncDir(target.dataDir);
  return { snapshotPath, wasDamaged };
}

/**
 * Throws if a database can't be read at all. It's opened only to read, because opening it to
 * write does away with a WAL that doesn't fit it, and that may hold what it lost.
 */
function checkReadable(path: string): void {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    db.prepare("SELECT count(*) FROM sqlite_master").get();
  } finally {
    db.close();
  }
}

async function saveDatabase(target: RestoreTarget, name: string): Promise<string> {
  const db = openDatabase(target.dbPath);
  try {
    return await saveSnapshot(db, target.dbPath, target.backupsDir, name);
  } finally {
    db.close();
  }
}

/** Keeps a database that can't be read, and its WAL, for anyone who can get more out of them. */
function keepDamaged(target: RestoreTarget, name: string): string {
  const kept = join(target.backupsDir, name);
  for (const ending of ["", "-wal"]) {
    if (!existsSync(`${target.dbPath}${ending}`)) continue;
    copyFileSync(`${target.dbPath}${ending}`, `${kept}${ending}`);
    fsyncFile(`${kept}${ending}`);
  }
  fsyncDir(target.backupsDir);
  return kept;
}

/** Keeps the key that's there, unless the backup brings the same one. */
function keepKey(target: RestoreTarget, replacement: Buffer, name: string): void {
  if (!existsSync(target.secretKeyPath)) return;
  const contents = readFileSync(target.secretKeyPath);
  if (parseSecretKey(contents)?.equals(replacement)) return;
  const kept = join(target.backupsDir, name);
  writeFileSync(kept, contents, { mode: 0o600 });
  fsyncFile(kept);
  fsyncDir(target.backupsDir);
}

/** Moves a checked backup's originals into the media store. Named by content, so one there is the same. */
function moveOriginals(checked: CheckedBackup, uploadsDir: string): void {
  const folders = new Set<string>();
  for (const file of checked.manifest.files) {
    if (!file.path.startsWith(ORIGINALS_PREFIX)) continue;
    const to = join(uploadsDir, file.path.slice("uploads/".length));
    if (existsSync(to)) continue;
    mkdirSync(dirname(to), { recursive: true });
    renameSync(join(checked.folder, file.path), to);
    folders.add(dirname(to));
  }
  for (const folder of folders) fsyncDir(folder);
}

export interface RunningSite extends RestoreTarget {
  /** Tend's own connection to the database, which stays open throughout. */
  db: SqliteDatabase;
  /** The key Tend is using, changed in place to the backup's. */
  secretKey: Buffer;
  migrationsDir: string;
  appVersion: string;
}

/**
 * Puts a checked backup in place of a site that's running, for Start from a backup (J10),
 * so nothing has to restart. The site as it was is saved first. SQLite's backup API then
 * copies the backup's data into the database Tend has open, which sees it from its next
 * query, and data from an older Tend is brought up to date there and then. The key changes
 * last, on disk and then in memory. If any of that fails, the site as it was is put back.
 */
export async function restoreRunning(
  checked: CheckedBackup,
  site: RunningSite,
  now = new Date(),
): Promise<{ snapshotPath: string }> {
  const stamp = now.toISOString().replace(/[-:]/g, "");
  const snapshotPath = await saveSnapshot(
    site.db,
    site.dbPath,
    site.backupsDir,
    `before-restore-${stamp}.db.gz`,
  );
  moveOriginals(checked, site.uploadsDir);
  try {
    await copyInto(join(checked.folder, DATABASE_ENTRY), site.dbPath);
    await migrate({
      dbPath: site.dbPath,
      backupsDir: site.backupsDir,
      migrationsDir: site.migrationsDir,
      appVersion: site.appVersion,
      log: () => {},
    });
    // Inside the try, so the site never keeps the backup's data without the key it was
    // saved with: if the key can't be written, the site is put back as it was.
    replaceKey(site.secretKeyPath, checked.key);
  } catch (error) {
    await putBack(snapshotPath, site, error);
    throw error;
  }
  site.secretKey.set(checked.key);
  return { snapshotPath };
}

/** Copies a database file's data into the one at `dbPath`, which may be open elsewhere. */
async function copyInto(from: string, dbPath: string): Promise<void> {
  const source = new Database(from, { readonly: true, fileMustExist: true });
  try {
    await source.backup(dbPath);
  } finally {
    source.close();
  }
}

/** Puts the saved site back after a restore that failed partway. */
async function putBack(snapshotPath: string, site: RunningSite, cause: unknown): Promise<void> {
  const unpacked = `${snapshotPath}.${process.pid}.putback`;
  try {
    writeFileSync(unpacked, gunzipSync(readFileSync(snapshotPath)), { mode: 0o600 });
    await copyInto(unpacked, site.dbPath);
  } catch (error) {
    throw new BackupError(
      `The backup couldn't be restored, and putting the site back failed too. The site as it was is saved in ${snapshotPath}.`,
      { cause: new AggregateError([cause, error]) },
    );
  } finally {
    rmSync(unpacked, { force: true });
  }
}

function freeSpace(path: string): number {
  const stats = statfsSync(path);
  return stats.bavail * stats.bsize;
}
