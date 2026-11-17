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
import { DATABASE_ENTRY } from "../backups/format.ts";
import {
  BackupError,
  checkBackup,
  type RestoreTarget,
  restoreRunning,
} from "../backups/restore.ts";
import { diskSpace } from "../backups/snapshots.ts";
import type { Orm } from "../db/client.ts";
import { SNAPSHOT_TMP_PREFIX } from "../db/migrate.ts";
import { appVersion, migrationsDir } from "../paths.ts";
import { parseBody, readJson } from "./admin/routing.ts";
import { ApiError } from "./errors.ts";

// Start from a backup (PLAN.md J10): at setup, a backup is uploaded a part at a time, so a
// big one survives a slow connection and a proxy's limit on request size, then checked and
// restored into the running site. Like the rest of setup, it needs the setup code, and only
// while no Owner exists.

export const BACKUP_PART_PATH = "/api/auth/setup/backup/part";
/** The most one part can hold. The admin sends 8 MB at a time. */
export const BACKUP_PART_BYTES = 8 * 1024 * 1024;
/** Where the parts are put together. Named so it's removed at boot if it's left behind. */
const UPLOAD = `${SNAPSHOT_TMP_PREFIX}setup-backup.zip`;
/** The zip, then the zip unpacked beside it, then the site restored from that. */
const ROOM_NEEDED = 2.5;

export interface SetupBackupOptions {
  orm: Orm;
  secretKey: Buffer;
  /** The data folder. Without it, as in some tests, there's nothing to restore into. */
  dataFolder?: RestoreTarget | undefined;
  onSiteChanged: () => void;
  requireSetupOpen: () => Promise<void>;
  requireSetupCode: (c: Context, code: string) => void;
}

/** How a restore went, kept for the setup screen to ask about. */
type Outcome = { state: "restoring" } | { state: "restored"; site: string } | ApiError;

const restoreSchema = z.object({
  code: z.string({ error: "Type your setup code." }).min(1).max(256),
  bytes: z.number().int().positive(),
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

/**
 * Makes a moved site's address provisional again, in the copy about to be restored, so the
 * old address never reaches the new site's links, sitemap or social previews. Until someone
 * confirms the new one, links follow the address each page was asked for (PLAN.md J10).
 */
function forgetAddress(dbPath: string): void {
  const db = new Database(dbPath, { fileMustExist: true });
  try {
    db.pragma("trusted_schema = OFF");
    db.prepare(
      `UPDATE settings
       SET value = json_set(value, '$.address', NULL, '$.address_confirmed', json('false'))
       WHERE key = 'site'`,
    ).run();
  } finally {
    db.close();
  }
}

function restoringNow(): ApiError {
  return new ApiError(409, "restoring", "A backup is being restored right now.", {
    fix: "Wait for it to finish, then reload this page.",
  });
}

/**
 * Adds the routes. What it returns lets the rest of setup wait while a restore runs, so
 * nothing is set up underneath one.
 */
export function registerSetupBackupRoutes(
  app: Hono,
  options: SetupBackupOptions,
): { requireNotRestoring: () => void } {
  let restoring = false;
  let latest: { id: string; outcome: Outcome } | null = null;

  function dataFolder(): RestoreTarget {
    if (!options.dataFolder) throw new Error("This Tend has no data folder to restore into.");
    return options.dataFolder;
  }

  app.post("/setup/backup/part", async (c) => {
    await options.requireSetupOpen();
    options.requireSetupCode(c, c.req.header("x-setup-code") ?? "");
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
    const path = join(backupsDir, UPLOAD);
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
  });

  // Checking every file of a big backup takes a while, longer than a proxy or a browser will
  // wait for one answer, so it runs on its own. The answer says where to ask how it's going.
  app.post("/setup/backup/restore", async (c) => {
    const body = await readJson(c);
    await options.requireSetupOpen();
    options.requireSetupCode(c, parseBody(restoreSchema.pick({ code: true }), body).code);
    const { bytes } = parseBody(restoreSchema, body);
    const folder = dataFolder();
    const upload = join(folder.backupsDir, UPLOAD);
    // Nothing between the check above and this one waits, so two can't start at once.
    if (restoring) throw restoringNow();
    if (!existsSync(upload) || statSync(upload).size !== bytes) {
      rmSync(upload, { force: true });
      throw new ApiError(409, "upload_incomplete", "Not all of the backup arrived.", {
        fix: "Choose the file again.",
      });
    }
    restoring = true;
    const id = randomBytes(16).toString("base64url");
    const job = { id, outcome: { state: "restoring" } as Outcome };
    latest = job;
    void restore(folder, upload).then((outcome) => {
      job.outcome = outcome;
    });
    return c.json({ restore: id }, 202);
  });

  app.get("/setup/backup/restore/:id", (c) => {
    const job = latest;
    if (!job || !sameId(job.id, c.req.param("id"))) {
      // Tend restarted since, or this is someone else's guess.
      throw new ApiError(404, "restore_unknown", "Tend isn't restoring that backup.", {
        fix: "Reload this page. If your site still isn't there, choose the file again.",
      });
    }
    if (job.outcome instanceof ApiError) throw job.outcome;
    return c.json(job.outcome);
  });

  async function restore(folder: RestoreTarget, upload: string): Promise<Outcome> {
    const unpacked = join(folder.backupsDir, `${SNAPSHOT_TMP_PREFIX}restore-${Date.now()}`);
    try {
      const newestSchema = readdirSync(migrationsDir).filter((name) => name.endsWith(".sql"));
      const checked = await checkBackup(upload, unpacked, newestSchema.length);
      forgetAddress(join(checked.folder, DATABASE_ENTRY));
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
      restoring = false;
      rmSync(upload, { force: true });
      rmSync(unpacked, { recursive: true, force: true });
    }
  }

  return {
    requireNotRestoring() {
      if (restoring) throw restoringNow();
    },
  };
}
