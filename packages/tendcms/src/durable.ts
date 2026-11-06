import { closeSync, fsyncSync, openSync } from "node:fs";

/** Forces a file's contents to disk, so a rename can't publish a half-written file. */
export function fsyncFile(path: string): void {
  const fd = openSync(path, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Forces a folder's entries to disk, so a rename survives a power cut. */
export function fsyncDir(path: string): void {
  // Windows can't open a folder this way, and NTFS journals renames itself.
  if (process.platform === "win32") return;
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
