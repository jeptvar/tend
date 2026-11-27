import { ApiError, api, OFFLINE } from "./api.ts";
import type { SetupStatus } from "./queries.ts";

// Restoring a backup: at setup, to start from one (PLAN.md J10), or from Settings → Backups.
// The file goes a part at a time, so a big one survives a slow connection and a proxy's limit
// on request size. Then Tend checks and restores it on its own, which can take minutes, while
// this asks how it's going.

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

/** Where the parts go: at setup, with its code, or from Settings → Backups, as the Owner. */
export interface PartsTo {
  path: string;
  headers?: Record<string, string>;
}

export function setupParts(code: string): PartsTo {
  return { path: "/api/auth/setup/backup/part", headers: { "X-Setup-Code": code } };
}

export const OWNER_PARTS: PartsTo = { path: "/api/auth/restore/part" };

/** Sends the whole file, a part at a time, reporting how much of it has gone. */
export async function sendBackup(
  file: File,
  to: PartsTo,
  onProgress: (fraction: number) => void,
  signal: AbortSignal,
): Promise<void> {
  for (let offset = 0; offset < file.size; ) {
    const start = offset;
    const part = file.slice(start, start + PART_BYTES);
    const report = (sent: number) => onProgress((start + sent) / file.size);
    offset = await sendPartPatiently({ part, offset: start, total: file.size, to }, report, signal);
    if (offset !== start + part.size) {
      throw new ApiError(409, "upload_out_of_step", "Part of the backup went missing on the way.");
    }
  }
}

interface Part {
  part: Blob;
  offset: number;
  total: number;
  to: PartsTo;
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
  { part, offset, total, to }: Part,
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

    request.open("POST", to.path);
    request.setRequestHeader("Content-Type", "application/octet-stream");
    for (const [name, value] of Object.entries(to.headers ?? {})) {
      request.setRequestHeader(name, value);
    }
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

/** A restore that's over: the site's name, and when what was restored was saved. */
export interface Restored {
  site: string;
  savedAt?: string;
}

type Progress = { state: "restoring" } | ({ state: "restored" } & Restored);

/**
 * Asks how the restore Tend answered with is going, until it's over. Calls `unknown` if Tend
 * has forgotten it, because it restarted, and answers with what that says.
 */
async function finished(
  path: string,
  signal: AbortSignal,
  unknown: (error: ApiError) => Promise<Restored | null>,
): Promise<Restored | null> {
  let answeredAt = Date.now();
  for (;;) {
    await wait(ASK_EVERY_MS, signal);
    try {
      const progress = await api<Progress>(path);
      if (progress.state === "restored") return { site: progress.site, savedAt: progress.savedAt };
      answeredAt = Date.now();
    } catch (error) {
      if (error instanceof ApiError && error.code === "restore_unknown") return unknown(error);
      const offlineTooLong = Date.now() - answeredAt > RESTORE_PATIENCE_MS;
      if (!(error instanceof ApiError && error.code === OFFLINE) || offlineTooLong) throw error;
    }
  }
}

/**
 * Asks Tend to restore what was sent at setup, then waits until it has. Answers with the
 * restored site's name, or null if Tend restarted meanwhile and the site turned out to be back
 * anyway.
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
  const restored = await finished(
    `/auth/setup/backup/restore/${restore}`,
    signal,
    async (error) => {
      // Tend restarted, which forgets how a restore went. If it finished, the site no longer
      // needs setting up.
      const status = await api<SetupStatus>("/auth/setup/status");
      if (!status.needsSetup) return null;
      throw error;
    },
  );
  return restored?.site ?? null;
}

/** Checks the Owner's password before a backup is sent, which can take minutes. */
export function checkOwnerPassword(password: string): Promise<unknown> {
  return api("/auth/restore/check", { method: "POST", body: { password } });
}

/**
 * Asks Tend to put the site back as it was, from what was sent or from a copy kept there, then
 * waits until it has. By then everyone is signed out.
 */
export async function restoreAsOwner(
  what: { password: string; bytes?: number; copy?: string },
  signal: AbortSignal,
): Promise<Restored> {
  const { restore } = await api<{ restore: string }>("/auth/restore", {
    method: "POST",
    body: what,
  });
  const restored = await finished(`/auth/restore/${restore}`, signal, async (error) => {
    // Tend restarted, so how it went is lost. Whoever reloads finds out.
    throw error;
  });
  if (!restored) throw new ApiError(404, "restore_unknown", "Tend isn't restoring that backup.");
  return restored;
}
