import { createHash } from "node:crypto";
import {
  closeSync,
  createReadStream,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  statfsSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { Unzip, UnzipInflate } from "fflate";
import { openDatabase } from "../db/client.ts";
import { readSchemaVersion, saveSnapshot } from "../db/migrate.ts";
import { fsyncDir } from "../durable.ts";
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
export class BackupError extends Error {}

export interface CheckedBackup {
  manifest: BackupManifest;
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

const NOT_A_BACKUP =
  "This file isn't a Tend backup, or it's damaged. Download a new backup from the site and try that.";
const DAMAGED =
  "The site's data in this backup is damaged, so it wasn't used. Download a new backup from the site and try that.";

/**
 * Unpacks a backup into `folder` and checks all of it before anything is restored
 * (PLAN.md §12): only the names a backup can hold, each file's SHA-256 against the
 * manifest, nothing missing or extra, and a database that passes integrity_check, opened
 * with trusted_schema off, from a Tend no newer than this one. It never takes more than 90%
 * of the free space, so a zip that unpacks to far more than it says stops early.
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
        refuse(
          "There isn't enough free space here to restore this backup. Free some space, then try again.",
        );
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
  checkDatabase(join(folder, DATABASE_ENTRY), manifest, newestSchema);
  return { manifest, folder };
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

function checkDatabase(path: string, manifest: BackupManifest, newestSchema: number): void {
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
 * first, as before-restore-<time>.db.gz in the backups folder, so a restore can be undone.
 * Originals go in first; they're named by their content, so one already there is the same
 * file. Then the key and the database, each by a rename, so neither is ever half there.
 */
export async function restoreBackup(
  checked: CheckedBackup,
  target: RestoreTarget,
  now = new Date(),
): Promise<{ snapshotPath: string | undefined }> {
  let snapshotPath: string | undefined;
  if (existsSync(target.dbPath)) {
    const db = openDatabase(target.dbPath);
    try {
      const stamp = now.toISOString().replace(/[-:]/g, "");
      snapshotPath = await saveSnapshot(
        db,
        target.dbPath,
        target.backupsDir,
        `before-restore-${stamp}.db.gz`,
      );
    } finally {
      db.close();
    }
  }

  const folders = new Set<string>();
  for (const file of checked.manifest.files) {
    if (!file.path.startsWith(ORIGINALS_PREFIX)) continue;
    const to = join(target.uploadsDir, file.path.slice("uploads/".length));
    if (existsSync(to)) continue;
    mkdirSync(dirname(to), { recursive: true });
    renameSync(join(checked.folder, file.path), to);
    folders.add(dirname(to));
  }
  for (const folder of folders) fsyncDir(folder);

  renameSync(join(checked.folder, KEY_ENTRY), target.secretKeyPath);
  // The site that was here may have left changes in its WAL. They belong to that database.
  for (const leftover of [`${target.dbPath}-wal`, `${target.dbPath}-shm`]) {
    rmSync(leftover, { force: true });
  }
  renameSync(join(checked.folder, DATABASE_ENTRY), target.dbPath);
  fsyncDir(target.dataDir);
  return { snapshotPath };
}

function freeSpace(path: string): number {
  const stats = statfsSync(path);
  return stats.bavail * stats.bsize;
}
