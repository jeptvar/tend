import { PassThrough, Readable } from "node:stream";
import { isForeignRequest } from "../../auth/csrf.ts";
import { backupFileName } from "../../backups/format.ts";
import { listSnapshots } from "../../backups/snapshots.ts";
import { writeBackup } from "../../backups/write.ts";
import { getSetting, putSetting } from "../../db/repo/settings.ts";
import { diskSpace } from "../../disk.ts";
import { ApiError } from "../errors.ts";
import type { AdminOptions, Routing } from "./routing.ts";

export interface BackupRouteOptions extends AdminOptions {
  /** Where the copies Tend makes are kept. Absent only in tests that don't need it. */
  backupsDir?: string | undefined;
  uploadsDir?: string | undefined;
  secretKey?: Buffer | undefined;
  version?: string | undefined;
}

/** Settings → Backups: download the whole site, see the copies kept here, and the disk. */
export function registerBackupRoutes(routing: Routing, options: BackupRouteOptions): void {
  const { orm } = options;
  const { now, route } = routing;

  function folders() {
    const { backupsDir, uploadsDir, secretKey } = options;
    if (!backupsDir || !uploadsDir || !secretKey) throw new Error("Backups aren't set up here.");
    return { backupsDir, uploadsDir, secretKey };
  }

  route("get", "/backups", "settings:manage", async (c) => {
    const { backupsDir } = folders();
    const backups = await getSetting(orm, "backups");
    const setup = await getSetting(orm, "setup");
    return c.json({
      snapshots: listSnapshots(backupsDir),
      disk: diskSpace(backupsDir),
      lastDownloadAt: backups?.last_download_at ?? null,
      // Overview's reminder counts from here until the first download.
      setUpAt: setup?.completed_at ?? null,
    });
  });

  route("get", "/backups/download", "backup:download", async (c, user) => {
    // A link on another site could start one, which makes the server do all of this. Like
    // every change, it has to come from the admin itself.
    const foreign = isForeignRequest({
      secFetchSite: c.req.header("sec-fetch-site"),
      origin: c.req.header("origin"),
      host: c.req.header("host"),
      publicUrl: options.address.setUrl,
    });
    if (foreign) {
      throw new ApiError(403, "foreign_request", "That request came from another website.", {
        fix: "Download the backup from Settings → Backups.",
      });
    }
    const { backupsDir, uploadsDir, secretKey } = folders();
    const site = (await getSetting(orm, "site"))?.name ?? "Tend";
    const at = new Date(now());
    const out = new PassThrough();
    // Done once the last of it has gone to the browser: that's when the download counts.
    writeBackup(
      {
        db: orm.$client,
        backupsDir,
        uploadsDir,
        secretKey,
        appVersion: options.version ?? "unknown",
        site,
      },
      out,
      at,
    )
      .then(() => putSetting(orm, "backups", { last_download_at: now() }, now(), user.id))
      .catch((error: Error) => {
        out.destroy(error);
        // A visitor leaving halfway isn't worth a message; anything else is.
        if (!/closed before it was done|premature close/i.test(error.message)) {
          console.error(`A backup download stopped: ${error.message}`);
        }
      });
    return new Response(Readable.toWeb(out) as ReadableStream, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${backupFileName(site, at)}"`,
        "Cache-Control": "no-store",
      },
    });
  });
}
