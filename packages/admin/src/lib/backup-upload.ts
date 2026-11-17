import { ApiError, api, OFFLINE } from "./api.ts";
import type { SetupStatus } from "./queries.ts";

// Start from a backup (PLAN.md J10). The file goes a part at a time, so a big one survives a
// slow connection and a proxy's limit on request size. Then Tend checks and restores it on
// its own, which can take minutes, while this asks how it's going.

/** As much as Tend takes in one part. */
const PART_BYTES = 8 * 1024 * 1024;
/** Tries at one part when the connection drops, waiting a little longer each time. */
const PART_TRIES = 5;
const RETRY_WAIT_MS = 2_000;
/** A part that sends nothing for this long is given up on, then tried again. */
const PART_IDLE_MS = 60_000;
/** How often to ask how the restore is going. */
const ASK_EVERY_MS = 1_000;
/** How long Tend can go without answering before the restore is given up on here. */
const RESTORE_PATIENCE_MS = 2 * 60_000;
/** The first bytes of every zip file. */
const ZIP_START = [0x50, 0x4b, 0x03, 0x04];

function offline(): ApiError {
  return new ApiError(0, OFFLINE, "Can't reach Tend.");
}

function stopped(): DOMException {
  return new DOMException("The backup stopped being sent.", "AbortError");
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(stopped());
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(stopped());
      },
      { once: true },
    );
  });
}

/** Whether a file could be a backup at all, checked before sending any of it. */
export async function looksLikeABackup(file: File): Promise<boolean> {
  if (file.size < ZIP_START.length) return false;
  const start = new Uint8Array(await file.slice(0, ZIP_START.length).arrayBuffer());
  return ZIP_START.every((byte, at) => start[at] === byte);
}

/** Sends the whole file, a part at a time, reporting how much of it has gone. */
export async function sendBackup(
  file: File,
  code: string,
  onProgress: (fraction: number) => void,
  signal: AbortSignal,
): Promise<void> {
  for (let offset = 0; offset < file.size; ) {
    const start = offset;
    const part = file.slice(start, start + PART_BYTES);
    const report = (sent: number) => onProgress((start + sent) / file.size);
    offset = await sendPartPatiently(
      { part, offset: start, total: file.size, code },
      report,
      signal,
    );
    if (offset !== start + part.size) {
      throw new ApiError(409, "upload_out_of_step", "Part of the backup went missing on the way.");
    }
  }
}

interface Part {
  part: Blob;
  offset: number;
  total: number;
  code: string;
}

/** Sends one part, and sends it again if the connection drops before Tend answers. */
async function sendPartPatiently(
  part: Part,
  onSent: (bytes: number) => void,
  signal: AbortSignal,
): Promise<number> {
  for (let tries = 1; ; tries++) {
    try {
      return await sendPart(part, onSent, signal);
    } catch (error) {
      if (!(error instanceof ApiError && error.code === OFFLINE) || tries >= PART_TRIES) {
        throw error;
      }
      onSent(0);
      await wait(RETRY_WAIT_MS * tries, signal);
    }
  }
}

/**
 * One try at one part, answered with how much of the file Tend has. XMLHttpRequest rather
 * than fetch, because only it can say how an upload is going.
 */
function sendPart(
  { part, offset, total, code }: Part,
  onSent: (bytes: number) => void,
  signal: AbortSignal,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    let idle: ReturnType<typeof setTimeout> | undefined;
    let stalled = false;
    const keepWaiting = () => {
      clearTimeout(idle);
      idle = setTimeout(() => {
        stalled = true;
        request.abort();
      }, PART_IDLE_MS);
    };
    const stop = () => request.abort();
    const done = () => {
      clearTimeout(idle);
      signal.removeEventListener("abort", stop);
    };

    request.open("POST", "/api/auth/setup/backup/part");
    request.setRequestHeader("Content-Type", "application/octet-stream");
    request.setRequestHeader("X-Setup-Code", code);
    request.setRequestHeader("X-Offset", String(offset));
    request.setRequestHeader("X-Backup-Bytes", String(total));
    request.responseType = "json";
    request.upload.onprogress = (event) => {
      keepWaiting();
      onSent(event.loaded);
    };
    request.onload = () => {
      done();
      const body = request.response as {
        received?: number;
        error?: { code: string; message: string; fix?: string };
      } | null;
      if (request.status === 200 && typeof body?.received === "number") {
        resolve(body.received);
      } else if (body?.error) {
        const { code: errorCode, message, fix } = body.error;
        reject(new ApiError(request.status, errorCode, message, undefined, fix));
      } else {
        // A proxy's own error page, or no answer at all.
        reject(offline());
      }
    };
    request.onerror = () => {
      done();
      reject(offline());
    };
    request.onabort = () => {
      done();
      reject(stalled ? offline() : stopped());
    };
    if (signal.aborted) return reject(stopped());
    signal.addEventListener("abort", stop, { once: true });
    keepWaiting();
    request.send(part);
  });
}

type Progress = { state: "restoring" } | { state: "restored"; site: string };

/**
 * Asks Tend to restore what was sent, then waits until it has. Answers with the restored
 * site's name, or null if Tend restarted meanwhile and the site turned out to be back anyway.
 */
export async function restoreBackup(
  code: string,
  bytes: number,
  signal: AbortSignal,
): Promise<string | null> {
  const { restore } = await api<{ restore: string }>("/auth/setup/backup/restore", {
    method: "POST",
    body: { code, bytes },
  });
  let answeredAt = Date.now();
  for (;;) {
    await wait(ASK_EVERY_MS, signal);
    try {
      const progress = await api<Progress>(`/auth/setup/backup/restore/${restore}`);
      if (progress.state === "restored") return progress.site;
      answeredAt = Date.now();
    } catch (error) {
      if (error instanceof ApiError && error.code === "restore_unknown") {
        // Tend restarted, which forgets how a restore went. If it finished, the site
        // no longer needs setting up.
        const status = await api<SetupStatus>("/auth/setup/status");
        if (!status.needsSetup) return null;
        throw error;
      }
      const offlineTooLong = Date.now() - answeredAt > RESTORE_PATIENCE_MS;
      if (!(error instanceof ApiError && error.code === OFFLINE) || offlineTooLong) throw error;
    }
  }
}
