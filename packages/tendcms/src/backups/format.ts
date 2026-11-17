// What a backup zip holds (PLAN.md §13): the database, the secret key, every uploaded
// original, and last a manifest listing them all with a SHA-256 each. Picture sizes are left
// out: they're made again from the originals the first time each is asked for.

/** Raised when the layout of a backup changes, so an older Tend can say it can't read one. */
export const BACKUP_FORMAT = 1;

export const DATABASE_ENTRY = "tend.db";
export const KEY_ENTRY = "secret.key";
export const MANIFEST_ENTRY = "manifest.json";
export const ORIGINALS_PREFIX = "uploads/originals/";

export interface BackupFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface BackupManifest {
  format: number;
  createdAt: string;
  /** The Tend that made it. */
  appVersion: string;
  /** Its database's schema version: a Tend can restore only one it knows. */
  schemaVersion: number;
  /** The site's name, for messages about the backup. */
  site: string;
  files: BackupFile[];
}

/** An original as the media store names it: <last 2 of its ID>/<ID>.<hash>.<ending>. */
const ORIGINAL =
  /^uploads\/originals\/([0-9a-f]{2})\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.[0-9a-f]{12}\.(?:jpg|png|webp|gif|avif|pdf)$/;

/** Whether a backup may hold a file of this name. Restoring refuses any other (PLAN.md §12). */
export function isBackupEntry(name: string): boolean {
  if (name === DATABASE_ENTRY || name === KEY_ENTRY || name === MANIFEST_ENTRY) return true;
  const original = ORIGINAL.exec(name);
  return original !== null && (original[2] as string).endsWith(original[1] as string);
}

/** rise-bakery-backup-PRIVATE-2027-11-21.zip. The name says it's private (PLAN.md §12). */
export function backupFileName(site: string, at: Date): string {
  const slug =
    site
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
      .replace(/-+$/, "") || "tend";
  return `${slug}-backup-PRIVATE-${at.toISOString().slice(0, 10)}.zip`;
}
