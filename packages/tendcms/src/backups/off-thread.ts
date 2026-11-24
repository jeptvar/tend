import type { Writable } from "node:stream";
import { finished } from "node:stream/promises";
import { Worker } from "node:worker_threads";
import type { BackupManifest } from "./format.ts";
import type { BackupSource } from "./write.ts";

// Starts backup-worker.ts, and passes on what it makes.

export type WorkerTask =
  | {
      kind: "backup";
      dbPath: string;
      backupsDir: string;
      uploadsDir: string;
      secretKey: Uint8Array;
      appVersion: string;
      site: string;
      now: number;
    }
  | { kind: "snapshot"; dbPath: string; backupsDir: string; name: string; check: boolean };

type Message =
  | { kind: "chunk"; bytes: Uint8Array }
  | { kind: "done"; result: unknown }
  | { kind: "failed"; message: string; code?: string };

/** How long a worker that was told to stop has to clear up after itself. */
const STOP_MS = 5000;

// Beside this file's folder when running from source, and beside the bundle when built.
const WORKER = import.meta.url.endsWith(".ts")
  ? new URL("../backup-worker.ts", import.meta.url)
  : new URL("./backup-worker.mjs", import.meta.url);

function start<Result>(task: WorkerTask, out?: Writable): Promise<Result> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER, { workerData: task });
    let settled = false;
    /** All of it has been made, so the destination closing is the end and not a loss. */
    let made = false;
    const settle = (act: () => void) => {
      if (settled) return;
      settled = true;
      act();
    };
    const fail = (error: Error) =>
      settle(() => {
        out?.destroy(error);
        reject(error);
      });

    // What went wrong is what the promise says. Nobody need be listening for it here as well.
    out?.on("error", () => {});
    worker.on("message", (message: Message) => {
      if (message.kind === "chunk") {
        // The next piece is asked for once this one has been taken, so the zip is never held
        // in memory however slow the download is.
        if (out?.write(Buffer.from(message.bytes))) worker.postMessage("more");
        else out?.once("drain", () => worker.postMessage("more"));
      } else if (message.kind === "done") {
        made = true;
        if (!out) settle(() => resolve(message.result as Result));
        else {
          out.end();
          finished(out)
            .then(() => settle(() => resolve(message.result as Result)))
            .catch(fail);
        }
      } else {
        fail(Object.assign(new Error(message.message), { code: message.code }));
      }
    });
    worker.on("error", fail);
    worker.on("exit", (code) => {
      if (code !== 0) fail(new Error(`The thread making a backup stopped (${code}).`));
    });
    out?.once("close", () => {
      if (settled || made) return;
      // Whoever it was for has gone.
      fail(new Error("The backup's destination closed before it was done."));
      worker.postMessage("stop");
      const timer = setTimeout(() => void worker.terminate(), STOP_MS);
      timer.unref();
      worker.once("exit", () => clearTimeout(timer));
    });
  });
}

/** Writes a backup zip to `out`, as writeBackup does, without holding up the site. */
export function writeBackupOffThread(
  { db, ...source }: BackupSource,
  out: Writable,
  now = new Date(),
): Promise<BackupManifest> {
  const task: WorkerTask = { kind: "backup", dbPath: db.name, ...source, now: now.getTime() };
  return start<BackupManifest>(task, out);
}

/** Saves a gzipped copy of the database, as saveSnapshot does, without holding up the site. */
export function saveSnapshotOffThread(
  dbPath: string,
  backupsDir: string,
  name: string,
  options: { check?: boolean } = {},
): Promise<string> {
  return start<string>({
    kind: "snapshot",
    dbPath,
    backupsDir,
    name,
    check: options.check === true,
  });
}
