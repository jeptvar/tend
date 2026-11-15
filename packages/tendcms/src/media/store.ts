import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fsyncDir, fsyncFile } from "../durable.ts";

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

  /** Written in full and forced to disk before it takes the real name. */
  write(path: string, data: Buffer): void {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temporary, data);
    fsyncFile(temporary);
    renameSync(temporary, path);
    fsyncDir(dirname(path));
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
