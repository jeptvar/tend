import {
  type Dirent,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { listSnapshots } from "../backups/snapshots.ts";
import { type DiskSpace, isNearlyFull } from "../disk.ts";
import { fsyncDir, fsyncFile } from "../durable.ts";

/** The name write() gives a file until it's complete: <name>.<process>.<time>.tmp. */
const TEMPORARY = /\.\d+\.\d+\.tmp$/;

/**
 * How far back a copy of the site's data holds on to the originals it shows. The daily and
 * weekly copies reach back five weeks or so. A copy kept from before an update can be far
 * older, and keeping every original deleted since then would hold on to space for months.
 */
const COPIES_HOLD_ORIGINALS_MS = 6 * 7 * 24 * 60 * 60 * 1000;

/**
 * Where uploads live in the data folder (PLAN.md §8). Originals are spread over folders by
 * the end of their ID, because the start is a timestamp that hardly changes. Each version
 * of a file is named by its content, so an address never shows two different pictures,
 * and replacing one never overwrites the copy an older backup points at.
 */
export class MediaStore {
  readonly #root: string;
  readonly #copiesDir: string | undefined;

  /**
   * `copiesDir` is where copies of the site's data are kept (backups/). An original the site
   * stops using stays while one of them could bring it back. Without it, none does.
   */
  constructor(uploadsDir: string, copiesDir?: string) {
    this.#root = uploadsDir;
    this.#copiesDir = copiesDir;
  }

  /**
   * When the oldest copy of the site's data that still holds on to originals was taken: the
   * oldest one kept from the last six weeks. Undefined if there's none.
   */
  oldestCopyAt(now: number): number | undefined {
    if (!this.#copiesDir) return undefined;
    const holding = listSnapshots(this.#copiesDir).filter(
      (copy) => copy.takenAt >= now - COPIES_HOLD_ORIGINALS_MS,
    );
    return holding.at(-1)?.takenAt;
  }

  originalPath(id: string, hash: string, ext: string): string {
    return join(this.#root, "originals", id.slice(-2), `${id}.${hash}.${ext}`);
  }

  versionDir(id: string, hash: string): string {
    return join(this.#root, "variants", id, hash);
  }

  variantPath(id: string, hash: string, name: string): string {
    return join(this.versionDir(id, hash), name);
  }

  /**
   * Written in full and forced to disk before it takes the real name. If that fails, a full
   * disk say, the part written goes too: nothing would ever use it, and it takes up the space
   * that ran out.
   */
  write(path: string, data: Buffer): void {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    try {
      writeFileSync(temporary, data);
      fsyncFile(temporary);
      renameSync(temporary, path);
    } catch (error) {
      try {
        rmSync(temporary, { force: true });
      } catch {
        // Then removeLeftovers takes it later. The failure that matters is the write's.
      }
      throw error;
    }
    fsyncDir(dirname(path));
  }

  /**
   * Removes files a crash left half written, from before `before`: a write takes seconds,
   * so one that old isn't still going. Returns how many went.
   */
  removeLeftovers(before: number): number {
    let entries: Dirent[];
    try {
      entries = readdirSync(this.#root, { recursive: true, withFileTypes: true });
    } catch {
      return 0;
    }
    let removed = 0;
    for (const entry of entries) {
      if (!entry.isFile() || !TEMPORARY.test(entry.name)) continue;
      const path = join(entry.parentPath, entry.name);
      try {
        if (statSync(path).mtimeMs >= before) continue;
        rmSync(path, { force: true });
        removed++;
      } catch {
        // Gone already, or can't go yet: it's looked at again next time.
      }
    }
    return removed;
  }

  read(path: string): Buffer | undefined {
    try {
      return readFileSync(path);
    } catch {
      return undefined;
    }
  }

  /** Removes one version: its original and its sizes. */
  removeVersion(id: string, hash: string, ext: string): void {
    this.removeOriginal(id, hash, ext);
    this.removeSizes(id, hash);
  }

  removeOriginal(id: string, hash: string, ext: string): void {
    rmSync(this.originalPath(id, hash, ext), { force: true });
  }

  /** Removes one version's sizes. They can be made again from its original. */
  removeSizes(id: string, hash: string): void {
    rmSync(this.versionDir(id, hash), { recursive: true, force: true });
  }

  /** Removes every size of every version, for something deleted forever. */
  removeAllSizes(id: string): void {
    rmSync(join(this.#root, "variants", id), { recursive: true, force: true });
  }

  /** Removes every size of every picture, and says how many bytes that freed. */
  removeEverySize(): number {
    const folder = join(this.#root, "variants");
    let bytes = 0;
    try {
      for (const entry of readdirSync(folder, { recursive: true, withFileTypes: true })) {
        if (entry.isFile()) bytes += statSync(join(entry.parentPath, entry.name)).size;
      }
    } catch {
      // There's nothing there yet, or a size went while it was counted.
    }
    // A size being made right now can recreate a folder underneath this, hence the retries.
    rmSync(folder, { recursive: true, force: true, maxRetries: 3 });
    return bytes;
  }
}

/**
 * Clears every picture size once the disk they're on is nearly full. They're made again when
 * they're next asked for, so they go before anything that can't be (PLAN.md §13). Returns the
 * bytes freed.
 */
export function clearSizesIfLow(store: MediaStore, space: DiskSpace): number {
  return isNearlyFull(space) ? store.removeEverySize() : 0;
}

/** The short form of a content hash used in addresses. */
export function shortHash(sha256: string): string {
  return sha256.slice(0, 12);
}
