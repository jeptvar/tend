import { statfsSync } from "node:fs";

export interface DiskSpace {
  total: number;
  free: number;
}

/** How full a disk gets before Tend clears what it can to make room (PLAN.md §13). */
export const NEARLY_FULL = 0.9;

/** Space on the disk that holds the data folder. */
export function diskSpace(path: string): DiskSpace {
  const stats = statfsSync(path);
  return { total: stats.blocks * stats.bsize, free: stats.bavail * stats.bsize };
}

export function isNearlyFull(space: DiskSpace): boolean {
  return space.total > 0 && (space.total - space.free) / space.total >= NEARLY_FULL;
}
