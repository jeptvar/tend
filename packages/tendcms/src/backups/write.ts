import { createHash } from "node:crypto";
import { readdirSync, rmSync, writeFileSync } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { join } from "node:path";
import type { Writable } from "node:stream";
import { finished } from "node:stream/promises";
import Database from "better-sqlite3";
import { Zip, ZipDeflate } from "fflate";
import type { SqliteDatabase } from "../db/client.ts";
import { quickCheck, readSchemaVersion, SNAPSHOT_TMP_PREFIX } from "../db/migrate.ts";
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

export interface BackupSource {
  db: SqliteDatabase;
  backupsDir: string;
  uploadsDir: string;
  secretKey: Buffer;
  appVersion: string;
  site: string;
}

/** Read, hashed and compressed this much at a time, so the server answers in between. */
const CHUNK = 64 * 1024;

/**
 * Writes a backup zip to `out` (PLAN.md §13). The database is copied with SQLite's backup
 * API, so the site keeps running while it's made, and the copy must pass quick_check before
 * it's used. Files go in 64 KB at a time, and writing waits whenever `out` is behind, a slow
 * download say, so the zip is never held in memory.
 *
 * Originals are stored as they are, at deflate level 0: they're photos and PDFs, already
 * compressed. Deflate's own framing still marks where each ends, so a reader never has to
 * search a photo for the bytes that would end a plain stored entry.
 */
export async function writeBackup(
  source: BackupSource,
  out: Writable,
  now = new Date(),
): Promise<BackupManifest> {
  const stamp = now.toISOString().replace(/[-:.]/g, "");
  const copy = join(source.backupsDir, `${SNAPSHOT_TMP_PREFIX}backup-${stamp}.db`);
  const zip = new ZipWriter(out);
  try {
    writeFileSync(copy, "");
    await source.db.backup(copy);
    const schemaVersion = checkCopy(copy);
    const database = await zip.addFile(DATABASE_ENTRY, copy, 6);
    if (!database) throw new Error("The copy of the site's data went missing.");
    const files: BackupFile[] = [database, await zip.addData(KEY_ENTRY, source.secretKey)];
    for (const name of originalsIn(source.uploadsDir)) {
      const path = join(source.uploadsDir, "originals", name);
      // One deleted forever since the list was made is no longer part of the site.
      const added = await zip.addFile(`${ORIGINALS_PREFIX}${name}`, path, 0);
      if (added) files.push(added);
    }
    const manifest: BackupManifest = {
      format: BACKUP_FORMAT,
      createdAt: now.toISOString(),
      appVersion: source.appVersion,
      schemaVersion,
      site: source.site,
      files,
    };
    await zip.addData(MANIFEST_ENTRY, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
    await zip.end();
    return manifest;
  } catch (error) {
    zip.abort(error as Error);
    throw error;
  } finally {
    for (const path of [copy, `${copy}-journal`, `${copy}-wal`, `${copy}-shm`]) {
      rmSync(path, { force: true });
    }
  }
}

/** The copy's schema version, once it has passed quick_check. */
function checkCopy(path: string): number {
  quickCheck(path);
  const copy = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return readSchemaVersion(copy);
  } finally {
    copy.close();
  }
}

/** Every original in the media store as <folder>/<file>, in a steady order. */
function originalsIn(uploadsDir: string): string[] {
  const root = join(uploadsDir, "originals");
  const names: string[] = [];
  let folders: string[];
  try {
    folders = readdirSync(root).sort();
  } catch {
    return names;
  }
  for (const folder of folders) {
    let files: string[];
    try {
      files = readdirSync(join(root, folder)).sort();
    } catch {
      continue;
    }
    // A write still under way has a temporary name, and isn't part of the site yet.
    for (const file of files) {
      if (isBackupEntry(`${ORIGINALS_PREFIX}${folder}/${file}`)) names.push(`${folder}/${file}`);
    }
  }
  return names;
}

/** fflate's streaming zip, written to a Node stream that may be slower than it. */
class ZipWriter {
  readonly #out: Writable;
  readonly #zip: Zip;
  #behind = false;
  #failed: Error | undefined;

  constructor(out: Writable) {
    this.#out = out;
    this.#zip = new Zip((error, chunk, final) => {
      if (error) {
        this.#failed = error;
        return;
      }
      if (!out.write(chunk)) this.#behind = true;
      if (final) out.end();
    });
  }

  /** Adds a file, or nothing if it isn't there. */
  async addFile(name: string, path: string, level: 0 | 6): Promise<BackupFile | undefined> {
    let file: FileHandle;
    try {
      file = await open(path, "r");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    try {
      const entry = new ZipDeflate(name, { level });
      this.#zip.add(entry);
      const hash = createHash("sha256");
      let bytes = 0;
      for await (const chunk of file.createReadStream({ highWaterMark: CHUNK, autoClose: false })) {
        hash.update(chunk);
        bytes += chunk.length;
        entry.push(chunk);
        await this.#caughtUp();
      }
      entry.push(new Uint8Array(0), true);
      await this.#caughtUp();
      return { path: name, bytes, sha256: hash.digest("hex") };
    } finally {
      await file.close();
    }
  }

  async addData(name: string, data: Buffer): Promise<BackupFile> {
    const entry = new ZipDeflate(name, { level: 6 });
    this.#zip.add(entry);
    entry.push(data, true);
    await this.#caughtUp();
    return {
      path: name,
      bytes: data.length,
      sha256: createHash("sha256").update(data).digest("hex"),
    };
  }

  async end(): Promise<void> {
    this.#zip.end();
    if (this.#failed) throw this.#failed;
    await finished(this.#out);
  }

  abort(error: Error): void {
    this.#zip.terminate();
    this.#out.destroy(error);
  }

  /** Waits while `out` has more than it can take, and stops if it closed or failed. */
  async #caughtUp(): Promise<void> {
    if (this.#failed) throw this.#failed;
    if (!this.#behind) return;
    await new Promise<void>((resolve, reject) => {
      const done = (error?: Error) => {
        this.#out.off("drain", drained);
        this.#out.off("error", done);
        this.#out.off("close", closed);
        if (error) reject(error);
        else resolve();
      };
      const drained = () => done();
      const closed = () => done(new Error("The backup's destination closed before it was done."));
      this.#out.once("drain", drained);
      this.#out.once("error", done);
      this.#out.once("close", closed);
    });
    this.#behind = false;
  }
}
