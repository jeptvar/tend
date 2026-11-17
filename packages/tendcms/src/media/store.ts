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
import { fsyncDir, fsyncFile } from "../durable.ts";

/** The name write() gives a file until it's complete: <name>.<process>.<time>.tmp. */
const TEMPORARY = /\.\d+\.\d+\.tmp$/;

/**
 * Where uploads live in the data folder (PLAN.md §8). Originals are spread over folders by
 * the end of their ID, because the start is a timestamp that hardly changes. Each version
 * of a file is named by its content, so an address never shows two different pictures,
 * and replacing one never overwrites the copy an older backup points at.
 */
export class MediaStore {
  readonly #root: string;

  constructor(uploadsDir: string) {
    this.#root = uploadsDir;
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
    rmSync(this.originalPath(id, hash, ext), { force: true });
    rmSync(this.versionDir(id, hash), { recursive: true, force: true });
  }

  /** Removes every size of every version, for something deleted forever. */
  removeAllSizes(id: string): void {
    rmSync(join(this.#root, "variants", id), { recursive: true, force: true });
  }
}

/** The short form of a content hash used in addresses. */
export function shortHash(sha256: string): string {
  return sha256.slice(0, 12);
}
