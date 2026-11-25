import { accessSync, constants, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { PlainError } from "../plain-error.ts";

export interface LockInfo {
  pid: number;
  startedAt: number;
}

export interface Lock {
  readonly path: string;
  release(): void;
}

export class LockError extends PlainError {
  readonly holder: LockInfo | undefined;

  constructor(holder: LockInfo | undefined) {
    super(
      holder
        ? `Tend is already running with this data folder (process ${holder.pid}). Close the other window first, or use a different data folder.`
        : "Tend is already running with this data folder. Close the other window first, or use a different data folder.",
    );
    this.holder = holder;
  }
}

// Two starts at the same instant can each make the other fail, so a busy answer
// only counts as "someone holds it" after a few spaced-out tries.
const ATTEMPTS = 8;
const RETRY_MIN_MS = 20;
const RETRY_JITTER_MS = 40;

// Holds a strong reference to each connection: if one were garbage collected, it
// would close and the lock would silently disappear.
const held = new Map<string, Database.Database>();

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isBusy(error: unknown): boolean {
  return String((error as { code?: unknown }).code).startsWith("SQLITE_BUSY");
}

function readInfo(path: string): LockInfo | undefined {
  try {
    const info = JSON.parse(readFileSync(path, "utf8"));
    if (Number.isInteger(info.pid) && Number.isInteger(info.startedAt)) return info;
  } catch {
    // Missing or half-written: it's only used to word the message.
  }
  return undefined;
}

function takeOsLock(path: string): Database.Database | undefined {
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const db = new Database(path, { timeout: 0 });
    try {
      db.exec("BEGIN EXCLUSIVE");
      return db;
    } catch (error) {
      db.close();
      if (!isBusy(error)) throw error;
    }
    if (attempt < ATTEMPTS - 1) sleepSync(RETRY_MIN_MS + Math.random() * RETRY_JITTER_MS);
  }
  return undefined;
}

/**
 * Whether Tend is running with a data folder, and as which process if that's known. Found
 * by reading, because taking the lock, even for a moment, could stop a Tend from starting.
 * Not for the process that holds it: see acquireLock.
 */
export function findRunning(dataDir: string): { holder: LockInfo | undefined } | undefined {
  const path = join(dataDir, ".lock.db");
  if (!existsSync(path)) return undefined;
  const db = new Database(path, { readonly: true, fileMustExist: true, timeout: 0 });
  try {
    db.prepare("SELECT count(*) FROM sqlite_master").get();
    return undefined;
  } catch (error) {
    if (!isBusy(error)) throw error;
    return { holder: readInfo(join(dataDir, ".lock")) };
  } finally {
    db.close();
  }
}

/**
 * Makes sure only one Tend process uses a data folder. The lock is an open
 * exclusive transaction on `<dataDir>/.lock.db`, so the operating system drops it
 * when the process dies, however it dies: there are no stale locks to judge and
 * PID reuse can't block a start. `<dataDir>/.lock` only records who holds it, for
 * the error message; a leftover one means nothing. Data folders on network
 * drives aren't supported, because SQLite's file locks aren't reliable there.
 *
 * Never read or copy `.lock.db` from the process holding the lock, including when
 * backing up the data folder: on POSIX, closing any descriptor for a file silently
 * drops the process's locks on it.
 */
export function acquireLock(dataDir: string): Lock {
  const path = join(dataDir, ".lock.db");
  const infoPath = join(dataDir, ".lock");
  if (held.has(path)) throw new LockError(readInfo(infoPath));

  // On a read-only file SQLite downgrades BEGIN EXCLUSIVE to a plain read, without
  // an error, so every process would believe it holds the lock.
  if (existsSync(path)) accessSync(path, constants.W_OK);

  const db = takeOsLock(path);
  if (!db) throw new LockError(readInfo(infoPath));
  held.set(path, db);

  try {
    const info: LockInfo = { pid: process.pid, startedAt: Date.now() };
    writeFileSync(infoPath, JSON.stringify(info), { mode: 0o600 });
  } catch {
    // A full disk shouldn't stop Tend here; a later step will explain the real problem.
  }

  let released = false;
  return {
    path,
    release() {
      if (released) return;
      released = true;
      // The info file goes first: once the connection closes, it may be someone else's.
      try {
        rmSync(infoPath, { force: true });
      } catch {
        // It means nothing if left behind, so it mustn't stop the connection closing
        // or replace whatever error is being reported.
      }
      held.delete(path);
      db.close();
    },
  };
}
