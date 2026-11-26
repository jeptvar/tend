import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { can } from "../auth/policy.ts";
import { DATABASE_ENTRY } from "../backups/format.ts";
import {
  BackupError,
  type CheckedBackup,
  checkBackup,
  checkCopy,
  type RestoreTarget,
  restoreRunning,
} from "../backups/restore.ts";
import { listSnapshots } from "../backups/snapshots.ts";
import type { Orm } from "../db/client.ts";
import { SNAPSHOT_TMP_PREFIX } from "../db/migrate.ts";
import { getSetting } from "../db/repo/settings.ts";
import type { User } from "../db/repo/users.ts";
import { diskSpace } from "../disk.ts";
import { appVersion, migrationsDir } from "../paths.ts";
import { parseBody, readJson } from "./admin/routing.ts";
import { ApiError } from "./errors.ts";

// Restoring a backup into the running site, so nothing has to restart. At setup, a backup
// moves a site here (PLAN.md J10). From Settings → Backups, the Owner puts the site back as it
// was, from a backup or from a copy kept here (v0.2). A backup is uploaded a part at a time,
// so a big one survives a slow connection and a proxy's limit on request size, then checked
// and restored. One restore at a time, whichever way it was started.

export const BACKUP_PART_PATH = "/api/auth/setup/backup/part";
export const OWNER_PART_PATH = "/api/auth/restore/part";
/** The most one part can hold. The admin sends 8 MB at a time. */
export const BACKUP_PART_BYTES = 8 * 1024 * 1024;
/** Where the parts are put together. Named so they're removed at boot if they're left behind. */
const SETUP_UPLOAD = `${SNAPSHOT_TMP_PREFIX}setup-backup.zip`;
const OWNER_UPLOAD = `${SNAPSHOT_TMP_PREFIX}restore-backup.zip`;
/** The zip, then the zip unpacked beside it, then the site restored from that. */
const ROOM_NEEDED = 2.5;

/** Whether a backup is being restored right now. The admin's changes wait meanwhile. */
export interface Restoring {
  now: boolean;
}

export interface RestoreOptions {
  orm: Orm;
  secretKey: Buffer;
  /** The data folder. Without it, as in some tests, there's nothing to restore into. */
  dataFolder?: RestoreTarget | undefined;
  restoring: Restoring;
  onSiteChanged: () => void;
  requireSetupOpen: () => Promise<void>;
  requireSetupCode: (c: Context, code: string) => void;
  requireUser: (c: Context) => Promise<User>;
  confirmPassword: (c: Context, user: User, password: string) => Promise<void>;
  /** Waits before a restore changes anything. Only tests use it, to see what happens meanwhile. */
  beforeRestore?: (() => Promise<void>) | undefined;
}

/** How a restore went, kept for whoever started it to ask about. */
type Outcome =
  | { state: "restoring" }
  | { state: "restored"; site: string; savedAt?: string | undefined }
  | ApiError;

const restoreSchema = z.object({
  code: z.string({ error: "Type your setup code." }).min(1).max(256),
  bytes: z.number().int().positive(),
});

const ownerRestoreSchema = z.object({
  password: z.string({ error: "Type your password." }).min(1, "Type your password.").max(1024),
  bytes: z.number().int().positive().optional(),
  copy: z.string().min(1).max(200).optional(),
});

function sameId(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Whether the file already ends with `part`, written there by an earlier try. */
function endsWith(path: string, part: Buffer): boolean {
  const fd = openSync(path, "r");
  try {
    const written = Buffer.alloc(part.length);
    const size = statSync(path).size;
    return readSync(fd, written, 0, part.length, size - part.length) === part.length
      ? written.equals(part)
      : false;
  } finally {
    closeSync(fd);
  }
}

/** Whether the copy about to be restored has a table, since the oldest ones have fewer. */
function hasTable(db: Database.Database, name: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
    undefined
  );
}

/**
 * Gives the copy about to be restored the address this site has now. At setup, that's none
 * yet, so a moved site's old address never reaches the new one's links, sitemap or social
 * previews, and links follow the address each page was asked for until someone confirms one
 * (PLAN.md J10). From Settings → Backups, the site stays where it is, whatever the backup says.
 */
function setAddress(dbPath: string, address: string | null, confirmed: boolean): void {
  const db = new Database(dbPath, { fileMustExist: true });
  try {
    db.pragma("trusted_schema = OFF");
    db.prepare(
      `UPDATE settings
       SET value = json_set(value, '$.address', ?, '$.address_confirmed', json(?))
       WHERE key = 'site'`,
    ).run(address, confirmed ? "true" : "false");
  } finally {
    db.close();
  }
}

/**
 * Signs everyone out of the copy about to be restored. Its sessions are the ones from when it
 * was saved, and some may have been ended since, on purpose, like a removed person's.
 */
function signEveryoneOut(dbPath: string): void {
  const db = new Database(dbPath, { fileMustExist: true });
  try {
    db.pragma("trusted_schema = OFF");
    if (hasTable(db, "sessions")) db.prepare("DELETE FROM sessions").run();
  } finally {
    db.close();
  }
}

export function restoringNow(): ApiError {
  return new ApiError(409, "restoring", "A backup is being restored right now.", {
    fix: "Wait for it to finish, then reload this page.",
  });
}

function newestSchema(): number {
  return readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).length;
}

/**
 * Adds the routes. What it returns lets the rest of setup wait while a restore runs, so
 * nothing is set up underneath one.
 */
export function registerRestoreRoutes(
  app: Hono,
  options: RestoreOptions,
): { requireNotRestoring: () => void } {
  const { restoring } = options;
  let latest: { id: string; outcome: Outcome } | null = null;

  function dataFolder(): RestoreTarget {
    if (!options.dataFolder) throw new Error("This Tend has no data folder to restore into.");
    return options.dataFolder;
  }

  /** Puts one part at the end of the backup being sent, in turn, and says how much is here. */
  async function receivePart(c: Context, upload: string): Promise<Response> {
    const { backupsDir } = dataFolder();
    const offset = Number(c.req.header("x-offset"));
    // The whole size, when it's sent, so a backup too big for this server is refused at the
    // start rather than most of the way through.
    const total = Number(c.req.header("x-backup-bytes") ?? 0);
    const part = Buffer.from(await c.req.arrayBuffer());
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(total) ||
      part.length === 0
    ) {
      throw new ApiError(400, "needs_fixing", "Tend couldn't read that part of the backup.", {
        fix: "Choose the file again.",
      });
    }
    const path = join(backupsDir, upload);
    // Each part follows the last, so nothing can end up in the file twice or out of order.
    // Starting again from 0 is always allowed.
    const received = offset === 0 || !existsSync(path) ? 0 : statSync(path).size;
    if (offset !== received) {
      // A part sent again because its answer was lost on the way back arrived the first
      // time, so it's taken as it is.
      if (offset + part.length === received && endsWith(path, part)) return c.json({ received });
      throw new ApiError(409, "upload_out_of_step", "Part of the backup went missing on the way.", {
        fix: "Choose the file again.",
      });
    }
    if (Math.max(offset + part.length, total) * ROOM_NEEDED > diskSpace(backupsDir).free) {
      throw new ApiError(413, "no_room", "There isn't enough free space here for this backup.", {
        fix: "Give this server more space, or restore it on one with more room.",
      });
    }
    const fd = openSync(path, offset === 0 ? "w" : "a", 0o600);
    try {
      writeSync(fd, part);
    } finally {
      closeSync(fd);
    }
    return c.json({ received: offset + part.length });
  }

  /** Whether all of the backup arrived. What did arrive is removed if not, so the next try starts clean. */
  function requireWholeUpload(upload: string, bytes: number): void {
    if (!existsSync(upload) || statSync(upload).size !== bytes) {
      rmSync(upload, { force: true });
      throw new ApiError(409, "upload_incomplete", "Not all of the backup arrived.", {
        fix: "Choose the file again.",
      });
    }
  }

  /**
   * Starts a restore on its own, since checking every file of a big backup takes longer than
   * a proxy or a browser will wait for one answer. The answer says where to ask how it's going.
   * Nothing between the caller's checks and this one waits, so two can't start at once.
   */
  function start(c: Context, work: () => Promise<Outcome>): Response {
    if (restoring.now) throw restoringNow();
    restoring.now = true;
    const id = randomBytes(16).toString("base64url");
    const job = { id, outcome: { state: "restoring" } as Outcome };
    latest = job;
    void Promise.resolve(options.beforeRestore?.())
      .then(() => work())
      .then((outcome) => {
        job.outcome = outcome;
      })
      .finally(() => {
        restoring.now = false;
      });
    return c.json({ restore: id }, 202);
  }

  /** How the restore with this ID went. The ID is only ever given to whoever started it. */
  function outcome(c: Context): Response {
    const job = latest;
    if (!job || !sameId(job.id, c.req.param("id") ?? "")) {
      // Tend restarted since, or this is someone else's guess.
      throw new ApiError(404, "restore_unknown", "Tend isn't restoring that backup.", {
        fix: "Reload this page. If your site still isn't there, choose the file again.",
      });
    }
    if (job.outcome instanceof ApiError) throw job.outcome;
    return c.json(job.outcome);
  }

  // At setup: like the rest of setup, it needs the setup code, and only while no Owner exists.

  app.post("/setup/backup/part", async (c) => {
    await options.requireSetupOpen();
    options.requireSetupCode(c, c.req.header("x-setup-code") ?? "");
    return receivePart(c, SETUP_UPLOAD);
  });

  app.post("/setup/backup/restore", async (c) => {
    const body = await readJson(c);
    await options.requireSetupOpen();
    options.requireSetupCode(c, parseBody(restoreSchema.pick({ code: true }), body).code);
    const { bytes } = parseBody(restoreSchema, body);
    const folder = dataFolder();
    const upload = join(folder.backupsDir, SETUP_UPLOAD);
    if (restoring.now) throw restoringNow();
    requireWholeUpload(upload, bytes);
    return start(c, () => restoreAtSetup(folder, upload));
  });

  app.get("/setup/backup/restore/:id", (c) => outcome(c));

  async function restoreAtSetup(folder: RestoreTarget, upload: string): Promise<Outcome> {
    const unpacked = join(folder.backupsDir, `${SNAPSHOT_TMP_PREFIX}restore-${Date.now()}`);
    try {
      const checked = await checkBackup(upload, unpacked, newestSchema());
      setAddress(join(checked.folder, DATABASE_ENTRY), null, false);
      await restoreRunning(checked, {
        ...folder,
        db: options.orm.$client,
        secretKey: options.secretKey,
        migrationsDir,
        appVersion,
      });
      options.onSiteChanged();
      return { state: "restored", site: checked.manifest.site };
    } catch (error) {
      if (error instanceof BackupError) {
        return new ApiError(400, "backup_refused", error.message, {
          fix: "Download a new backup from the site you're moving, and choose that.",
        });
      }
      console.error("Tend couldn't restore that backup:", error);
      return new ApiError(500, "restore_failed", "Tend couldn't restore that backup.", {
        fix: "Tend's log has the details. Your new site is as it was, so you can try again.",
      });
    } finally {
      rmSync(upload, { force: true });
      rmSync(unpacked, { recursive: true, force: true });
    }
  }

  // From Settings → Backups: only the Owner, who says their password again, since a backup
  // replaces every account. How it went can be asked without signing in, because everyone is
  // signed out by the end of it.

  async function requireOwner(c: Context): Promise<User> {
    const user = await options.requireUser(c);
    if (!can(user, "backup:restore")) {
      throw new ApiError(403, "not_allowed", "Only the Owner can restore a backup.", {
        fix: "Ask the Owner.",
      });
    }
    return user;
  }

  // Asked before a backup is sent, which can take minutes, so a mistyped password is caught
  // first. Starting the restore asks again.
  app.post("/restore/check", async (c) => {
    const user = await requireOwner(c);
    const body = await readJson(c);
    const { password } = parseBody(ownerRestoreSchema.pick({ password: true }), body);
    await options.confirmPassword(c, user, password);
    return c.body(null, 204);
  });

  app.post("/restore/part", async (c) => {
    // Who it is comes before reading any of it, so nobody else can fill the server's disk.
    await requireOwner(c);
    if (restoring.now) throw restoringNow();
    return receivePart(c, OWNER_UPLOAD);
  });

  app.post("/restore", async (c) => {
    const user = await requireOwner(c);
    const { password, bytes, copy } = parseBody(ownerRestoreSchema, await readJson(c));
    if ((bytes === undefined) === (copy === undefined)) {
      throw new ApiError(400, "needs_fixing", "Say which backup to restore.", {
        fix: "Choose a backup file, or one of the copies kept here.",
      });
    }
    // Before the password, which takes a while to check, and needn't be when the answer is no.
    if (restoring.now) throw restoringNow();
    await options.confirmPassword(c, user, password);
    const folder = dataFolder();
    if (restoring.now) throw restoringNow();
    if (bytes !== undefined) {
      const upload = join(folder.backupsDir, OWNER_UPLOAD);
      requireWholeUpload(upload, bytes);
      return start(c, () => restoreForOwner(folder, { upload }));
    }
    // The ID comes from the list, never a path: only a copy that's in it is restored.
    const kept = listSnapshots(folder.backupsDir).find(({ id }) => id === copy);
    if (!kept) {
      throw new ApiError(404, "not_found", "That copy is no longer here.", {
        fix: "Reload this page to see the ones that are.",
      });
    }
    return start(c, () =>
      restoreForOwner(folder, {
        copy: join(folder.backupsDir, `${kept.id}.db.gz`),
        savedAt: new Date(kept.takenAt).toISOString(),
      }),
    );
  });

  app.get("/restore/:id", (c) => outcome(c));

  async function restoreForOwner(
    folder: RestoreTarget,
    from: { upload: string } | { copy: string; savedAt: string },
  ): Promise<Outcome> {
    const unpacked = join(folder.backupsDir, `${SNAPSHOT_TMP_PREFIX}restore-${Date.now()}`);
    try {
      let checked: CheckedBackup;
      let savedAt: string;
      if ("upload" in from) {
        checked = await checkBackup(from.upload, unpacked, newestSchema());
        savedAt = checked.manifest.createdAt;
      } else {
        const copy = await checkCopy(from.copy, unpacked, newestSchema(), folder);
        // With no key kept beside the copy, or in the data folder, the site keeps the one it
        // uses now, rather than one made up, which nothing made before would work with.
        checked = copy.newKey ? { ...copy, key: Buffer.from(options.secretKey) } : copy;
        savedAt = from.savedAt;
      }
      const here = await getSetting(options.orm, "site");
      const restoredDb = join(checked.folder, DATABASE_ENTRY);
      setAddress(restoredDb, here?.address ?? null, here?.address_confirmed ?? false);
      signEveryoneOut(restoredDb);
      await restoreRunning(checked, {
        ...folder,
        db: options.orm.$client,
        secretKey: options.secretKey,
        migrationsDir,
        appVersion,
        keepKey: true,
      });
      options.onSiteChanged();
      const site = (await getSetting(options.orm, "site"))?.name ?? checked.manifest.site;
      return { state: "restored", site, savedAt };
    } catch (error) {
      if (error instanceof BackupError) {
        return new ApiError(400, "backup_refused", error.message, {
          fix: "Choose another backup, or one of the copies kept here.",
        });
      }
      console.error("Tend couldn't restore that backup:", error);
      return new ApiError(500, "restore_failed", "Tend couldn't restore that backup.", {
        fix: "Tend's log has the details. Your site is as it was, so you can try again.",
      });
    } finally {
      if ("upload" in from) rmSync(from.upload, { force: true });
      rmSync(unpacked, { recursive: true, force: true });
    }
  }

  return {
    requireNotRestoring() {
      if (restoring.now) throw restoringNow();
    },
  };
}
