import { statfsSync } from "node:fs";

export interface DiskSpace {
  total: number;
  free: number;
}

/** How full a disk gets before it counts as running low, as in Settings → Backups. */
const RUNNING_LOW = 0.8;
/** How full it gets before Tend clears what it can to make room (PLAN.md §13). */
const NEARLY_FULL = 0.9;

/** Space on the disk that holds the data folder. */
export function diskSpace(path: string): DiskSpace {
  const stats = statfsSync(path);
  return { total: stats.blocks * stats.bsize, free: stats.bavail * stats.bsize };
}

function fullness({ total, free }: DiskSpace): number {
  return total > 0 ? (total - free) / total : 0;
}

export function isRunningLow(space: DiskSpace): boolean {
  return fullness(space) >= RUNNING_LOW;
}

export function isNearlyFull(space: DiskSpace): boolean {
  return fullness(space) >= NEARLY_FULL;
}
