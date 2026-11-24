import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { diskSpace } from "../disk.ts";
import { saveSnapshotOffThread } from "./off-thread.ts";

// Copies of the site's database kept in the backups folder (PLAN.md §13): one each day at
// 03:00 site time, a week of them and four weekly ones. Tend also saves one before each update
// and before each restore, and when someone asks for one. All of them together never take more
// than 20% of the disk. They hold the database only: a full backup, with the uploads, is the
// zip Settings → Backups downloads.

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const DAILY_KEPT = 7;
const WEEKLY_KEPT = 4;
/** How many are kept of the ones that aren't made each day. */
const OTHERS_KEPT = { update: 3, restore: 3, manual: 5 } as const;
const MOST_OF_DISK = 0.2;
/** The hour, in the site's own time, a day's copy is made. */
const HOUR = 3;

export type SnapshotKind = "daily" | "update" | "restore" | "manual";

export interface Snapshot {
  /** Its name without .db.gz: copies are addressed by this, never by a path. */
  id: string;
  kind: SnapshotKind;
  takenAt: number;
  bytes: number;
}

const NAMES: [RegExp, SnapshotKind][] = [
  [/^daily-(\d{8}T\d{6}\.\d{3}Z)\.db\.gz$/, "daily"],
  [/^pre-.+-(\d{8}T\d{6}\.\d{3}Z)\.db\.gz$/, "update"],
  [/^before-restore-(\d{8}T\d{6}\.\d{3}Z)\.db\.gz$/, "restore"],
  [/^manual-(\d{8}T\d{6}\.\d{3}Z)\.db\.gz$/, "manual"],
];

/** 20261117T030000.000Z, as the snapshots are named, back to a time. */
function timeOf(stamp: string): number {
  const iso = stamp.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/, "$1-$2-$3T$4:$5:$6");
  return Date.parse(iso);
}

function stampOf(at: number): string {
  return new Date(at).toISOString().replace(/[-:]/g, "");
}

/** Every copy in the backups folder, newest first. */
export function listSnapshots(backupsDir: string): Snapshot[] {
  let names: string[];
  try {
    names = readdirSync(backupsDir);
  } catch {
    return [];
  }
  const found: Snapshot[] = [];
  for (const name of names) {
    for (const [pattern, kind] of NAMES) {
      const stamp = pattern.exec(name)?.[1];
      if (!stamp) continue;
      try {
        const bytes = statSync(join(backupsDir, name)).size;
        found.push({ id: name.slice(0, -".db.gz".length), kind, takenAt: timeOf(stamp), bytes });
      } catch {
        // Removed since the folder was read.
      }
      break;
    }
  }
  return found.sort((a, b) => b.takenAt - a.takenAt);
}

/** The day and hour at `at` where the site is. A time zone Tend can't use counts as UTC. */
function localTime(at: number, timeZone: string): { day: string; hour: number } {
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    return localTime(at, "UTC");
  }
  const parts = Object.fromEntries(format.formatToParts(at).map((part) => [part.type, part.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

/**
 * Whether today's copy is still to make: it's 03:00 or later where the site is, and none
 * was made since then today. If Tend wasn't running at 03:00, it's made when it next is.
 */
export function dailySnapshotDue(takenAt: number[], now: number, timeZone: string): boolean {
  const today = localTime(now, timeZone);
  if (today.hour < HOUR) return false;
  return !takenAt.some((at) => {
    const then = localTime(at, timeZone);
    return then.day === today.day && then.hour >= HOUR;
  });
}

/** All but the newest 7 daily copies, and the newest of each of the 4 weeks before them. */
function keptDaily(daily: Snapshot[]): Snapshot[] {
  const kept = daily.slice(0, DAILY_KEPT);
  // Weeks from Monday (the Unix epoch was a Thursday). The weekly copies come from weeks
  // the daily ones don't reach, so between them they go back five weeks or so.
  const weekOf = (snapshot: Snapshot) => Math.floor((snapshot.takenAt + 3 * DAY_MS) / WEEK_MS);
  const weeks = new Set(kept.map(weekOf));
  let weekly = 0;
  for (const snapshot of daily.slice(DAILY_KEPT)) {
    if (weekly >= WEEKLY_KEPT) break;
    if (weeks.has(weekOf(snapshot))) continue;
    weeks.add(weekOf(snapshot));
    kept.push(snapshot);
    weekly++;
  }
  return kept;
}

/**
 * The copies to remove: all but the newest few of each kind, and then the oldest of any kind
 * until what's left takes no more than 20% of the disk. The newest of all is always kept.
 */
export function snapshotsToRemove(snapshots: Snapshot[], diskBytes: number): Snapshot[] {
  const newestFirst = [...snapshots].sort((a, b) => b.takenAt - a.takenAt);
  const of = (kind: SnapshotKind) => newestFirst.filter((snapshot) => snapshot.kind === kind);
  const kept = [
    ...keptDaily(of("daily")),
    ...(["update", "restore", "manual"] as const).flatMap((kind) =>
      of(kind).slice(0, OTHERS_KEPT[kind]),
    ),
  ].sort((a, b) => b.takenAt - a.takenAt);
  let total = kept.reduce((sum, snapshot) => sum + snapshot.bytes, 0);
  while (kept.length > 1 && total > diskBytes * MOST_OF_DISK) {
    total -= (kept.pop() as Snapshot).bytes;
  }
  const keep = new Set(kept.map((snapshot) => snapshot.id));
  return newestFirst.filter((snapshot) => !keep.has(snapshot.id));
}

/** Removes the copies there's no keeping, and the key kept beside one saved before a restore. */
export function pruneSnapshots(backupsDir: string): void {
  const snapshots = listSnapshots(backupsDir);
  for (const old of snapshotsToRemove(snapshots, diskSpace(backupsDir).total)) {
    for (const ending of [".db.gz", ".secret.key"]) {
      rmSync(join(backupsDir, `${old.id}${ending}`), { force: true });
    }
  }
}

async function takeSnapshot(
  kind: "daily" | "manual",
  options: { dbPath: string; backupsDir: string; now: number },
): Promise<Snapshot> {
  const { dbPath, backupsDir, now } = options;
  const name = `${kind}-${stampOf(now)}.db.gz`;
  const path = await saveSnapshotOffThread(dbPath, backupsDir, name, { check: true });
  const made: Snapshot = {
    id: name.slice(0, -".db.gz".length),
    kind,
    takenAt: now,
    bytes: statSync(path).size,
  };
  pruneSnapshots(backupsDir);
  return made;
}

/** Makes a copy because someone asked for one, checked like the daily ones. */
export function takeManualSnapshot(options: {
  dbPath: string;
  backupsDir: string;
  now: number;
}): Promise<Snapshot> {
  return takeSnapshot("manual", options);
}

/**
 * Makes today's copy if it's due, checks it, and prunes the old ones. Returns the copy made,
 * if one was.
 */
export async function takeDailySnapshot(options: {
  dbPath: string;
  backupsDir: string;
  timeZone: string;
  now: number;
}): Promise<Snapshot | undefined> {
  const taken = listSnapshots(options.backupsDir)
    .filter((each) => each.kind === "daily")
    .map((each) => each.takenAt);
  if (!dailySnapshotDue(taken, options.now, options.timeZone)) return undefined;
  return takeSnapshot("daily", options);
}
