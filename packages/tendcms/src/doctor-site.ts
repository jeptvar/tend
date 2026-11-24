import { existsSync, readdirSync } from "node:fs";
import Database from "better-sqlite3";
import { listSnapshots } from "./backups/snapshots.ts";
import { type Config, readSecretKey } from "./config.ts";
import { damagedDatabase, isDamage } from "./db/damage.ts";
import { findRunning } from "./db/lock.ts";
import { newerData, readSchemaVersion } from "./db/migrate.ts";
import { type Finding, formatDay } from "./doctor.ts";
import { appVersion, migrationsDir } from "./paths.ts";
import { PlainError } from "./plain-error.ts";

// The part of `tendcms doctor` that looks at the site itself. It needs the database component,
// so doctor.ts only loads it once that has.

const DAY_MS = 24 * 60 * 60 * 1000;
/** Tend makes a copy each day it's running, so one this old means it couldn't. */
const COPY_OVERDUE_MS = 2 * DAY_MS;

export interface SiteReport {
  /** Whether first-time setup is done. */
  isSetUp: boolean;
  findings: Finding[];
}

/** The first thing wrong with the database, if it's damaged. */
function damage(db: Database.Database): string | undefined {
  const [first = "", second] = String(db.pragma("quick_check(1)", { simple: true })).split("\n");
  // The first line only says which database it's about.
  return first === "ok" ? undefined : (second ?? first);
}

/**
 * Looks the database over without changing it, whether or not Tend is running with it. If it
 * isn't, SQLite leaves an empty tend.db-wal and a tend.db-shm, and tidies them up next time.
 */
function lookAtDatabase(dbPath: string): SiteReport {
  const damaged = (why: string): SiteReport => ({
    // There's something here to lose, whatever it says.
    isSetUp: true,
    findings: [{ kind: "FIX", text: damagedDatabase(why).message }],
  });
  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const why = damage(db);
    if (why) return damaged(why);
    const version = readSchemaVersion(db);
    const newest = readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).length;
    const isSetUp =
      version > 0 && db.prepare("SELECT 1 FROM users WHERE is_owner = 1").get() !== undefined;
    if (version > newest) {
      return { isSetUp, findings: [{ kind: "FIX", text: newerData(db, appVersion).message }] };
    }
    const update = version < newest ? " Tend will update it when it next starts." : "";
    return {
      isSetUp,
      findings: [{ kind: "OK", text: `The site's database is in good order.${update}` }],
    };
  } catch (error) {
    if (isDamage(error)) return damaged((error as Error).message);
    throw error;
  } finally {
    db?.close();
  }
}

function lookAtKey(config: Config): Finding {
  if (!existsSync(config.secretKeyPath)) {
    return {
      kind: "FIX",
      text: `The key file ${config.secretKeyPath} is missing. Put it back from a backup. If Tend starts without it, it makes a new one, and people's recovery codes stop working.`,
    };
  }
  try {
    readSecretKey(config);
    return { kind: "OK", text: "The site's key file is in place." };
  } catch (error) {
    if (error instanceof PlainError) return { kind: "FIX", text: error.message };
    throw error;
  }
}

function lookAtCopies(config: Config, now: number, isRunning: boolean): Finding | undefined {
  const newest = listSnapshots(config.backupsDir).find(({ kind }) => kind === "daily");
  if (!newest) return undefined;
  const day = formatDay(newest.takenAt);
  if (isRunning && now - newest.takenAt > COPY_OVERDUE_MS) {
    return {
      kind: "LOOK",
      text: `Tend saves a copy of the site's data each day, but the newest is from ${day}. What Tend prints as it runs says why.`,
    };
  }
  return { kind: "OK", text: `The newest copy of the site's data is from ${day}.` };
}

export function lookAtSite(config: Config, now: number): SiteReport {
  const running = findRunning(config.dataDir);
  const { isSetUp, findings } = lookAtDatabase(config.dbPath);
  const copies = lookAtCopies(config, now, running !== undefined);
  const process = running?.holder ? ` (process ${running.holder.pid})` : "";
  return {
    isSetUp,
    findings: [
      ...findings,
      lookAtKey(config),
      ...(copies ? [copies] : []),
      {
        kind: "OK",
        text: running ? `Tend is running here${process}.` : "Tend isn't running here just now.",
      },
    ],
  };
}
