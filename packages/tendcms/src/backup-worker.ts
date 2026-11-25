import { Writable } from "node:stream";
import { parentPort, workerData } from "node:worker_threads";
import type { WorkerTask } from "./backups/off-thread.ts";
import { writeBackup } from "./backups/write.ts";
import { openDatabase } from "./db/client.ts";
import { saveSnapshot } from "./db/migrate.ts";

// Copies of the site's data and backup zips are made here, in a thread of their own with its
// own connection to the database (PLAN.md §7), so the site answers as quickly meanwhile. WAL
// lets it read while Tend writes. See backups/off-thread.ts, which starts it.

const port = parentPort;
if (!port) throw new Error("This only runs as a worker thread.");
const task = workerData as WorkerTask;

/** Sends what's written to the main thread, a piece at a time, as it's ready for more. */
class ToMain extends Writable {
  #done: (() => void) | undefined;

  override _write(chunk: Uint8Array, _encoding: unknown, done: () => void): void {
    this.#done = done;
    // A copy of its own, so it can be handed over rather than copied again.
    const bytes = Uint8Array.from(chunk);
    port?.postMessage({ kind: "chunk", bytes }, [bytes.buffer]);
  }

  more(): void {
    const done = this.#done;
    this.#done = undefined;
    done?.();
  }
}

async function run(): Promise<void> {
  const db = openDatabase(task.dbPath);
  try {
    if (task.kind === "snapshot") {
      const { dbPath, backupsDir, name, check } = task;
      const path = await saveSnapshot(db, dbPath, backupsDir, name, { check });
      port?.postMessage({ kind: "done", result: path });
      return;
    }
    const out = new ToMain({ highWaterMark: 256 * 1024 });
    // Nobody wants the rest. What's being written stops and clears up after itself.
    out.on("error", () => {});
    port?.on("message", (message: "more" | "stop") => {
      if (message === "more") out.more();
      else out.destroy();
    });
    const manifest = await writeBackup(
      { ...task, db, secretKey: Buffer.from(task.secretKey) },
      out,
      new Date(task.now),
    );
    port?.postMessage({ kind: "done", result: manifest });
  } finally {
    db.close();
  }
}

run()
  .catch((error: NodeJS.ErrnoException) => {
    port.postMessage({ kind: "failed", message: error.message, code: error.code });
  })
  // Only listening for messages keeps the thread going now.
  .finally(() => port.close());
