import { createReadStream, statSync } from "node:fs";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import type { Context } from "hono";
import { isForeignRequest } from "../../auth/csrf.ts";
import { backupFileName, copyFileName } from "../../backups/format.ts";
import { writeBackupOffThread } from "../../backups/off-thread.ts";
import { listSnapshots, takeManualSnapshot } from "../../backups/snapshots.ts";
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

  async function backupsJson() {
    const { backupsDir } = folders();
    const backups = await getSetting(orm, "backups");
    const setup = await getSetting(orm, "setup");
    return {
      snapshots: listSnapshots(backupsDir),
      disk: diskSpace(backupsDir),
      lastDownloadAt: backups?.last_download_at ?? null,
      // Overview's reminder counts from here until the first download.
      setUpAt: setup?.completed_at ?? null,
    };
  }

  /**
   * A link on another site could start a download, which makes the server do all of it. Like
   * every change, it has to come from the admin itself.
   */
  function refuseForeign(c: Context): void {
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
  }

  route("get", "/backups", "settings:manage", async (c) => c.json(await backupsJson()));

  // One at a time: each reads the whole database.
  let copying: Promise<unknown> | undefined;

  route("post", "/backups", "settings:manage", async (c) => {
    const { backupsDir } = folders();
    copying ??= takeManualSnapshot({ dbPath: orm.$client.name, backupsDir, now: now() }).finally(
      () => {
        copying = undefined;
      },
    );
    await copying;
    return c.json(await backupsJson(), 201);
  });

  // The ID comes from the list, never a path: only a copy that's in it is sent.
  route("get", "/backups/:bid/download", "backup:download", async (c) => {
    refuseForeign(c);
    const { backupsDir } = folders();
    const copy = listSnapshots(backupsDir).find(({ id }) => id === c.req.param("bid"));
    if (!copy) {
      throw new ApiError(404, "not_found", "That copy is no longer here.", {
        fix: "Reload this page to see the ones that are.",
      });
    }
    const path = join(backupsDir, `${copy.id}.db.gz`);
    const site = (await getSetting(orm, "site"))?.name ?? "Tend";
    return new Response(Readable.toWeb(createReadStream(path)) as ReadableStream, {
      headers: {
        "Content-Type": "application/gzip",
        "Content-Length": String(statSync(path).size),
        "Content-Disposition": `attachment; filename="${copyFileName(site, new Date(copy.takenAt))}"`,
        "Cache-Control": "no-store",
      },
    });
  });

  route("get", "/backups/download", "backup:download", async (c, user) => {
    refuseForeign(c);
    const { backupsDir, uploadsDir, secretKey } = folders();
    const site = (await getSetting(orm, "site"))?.name ?? "Tend";
    const at = new Date(now());
    const out = new PassThrough();
    // Done once the last of it has gone to the browser: that's when the download counts.
    writeBackupOffThread(
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
