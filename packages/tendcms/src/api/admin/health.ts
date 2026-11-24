import { statSync } from "node:fs";
import { homedir } from "node:os";
import { listSnapshots } from "../../backups/snapshots.ts";
import { componentError, PICTURES } from "../../components.ts";
import type { Platform } from "../../config.ts";
import { settingValue } from "../../content/settings.ts";
import { getSetting } from "../../db/repo/settings.ts";
import { diskSpace } from "../../disk.ts";
import {
  addressFindings,
  diskFinding,
  type Finding,
  fix,
  formatDay,
  look,
  nodeFinding,
  ok,
  withoutHome,
} from "../../doctor.ts";
import { pictureError } from "../../media/process.ts";
import type { Themes } from "../../site/themes.ts";
import { type DataRiskDetails, dataRiskReason, dataRiskSteps } from "../../volume.ts";
import type { AdminOptions, Routing } from "./routing.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Tend makes a copy each day it's running, so one this old means it couldn't. */
const COPY_OVERDUE_MS = 2 * DAY_MS;

export interface HealthRouteOptions extends AdminOptions {
  version?: string | undefined;
  platform?: Platform | undefined;
  themes: Themes;
  trustProxy?: number | undefined;
  dataRisk?: DataRiskDetails | undefined;
  /** Absent only in tests that don't need them. */
  backupsDir?: string | undefined;
  dbPath?: string | undefined;
}

function sizeOf(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

/**
 * How Tend is doing, for the Help screen: what's running where, and what `tendcms doctor`
 * would say about it that can be told while it runs. Nothing in it names anyone.
 */
export function registerHealthRoutes(routing: Routing, options: HealthRouteOptions): void {
  const { orm, address, themes, backupsDir, dataRisk } = options;
  const { now, route } = routing;
  const platform = options.platform ?? "local";

  async function findings(): Promise<Finding[]> {
    const found: Finding[] = [];
    if (dataRisk) {
      found.push(fix([dataRiskReason(dataRisk), ...dataRiskSteps(dataRisk, false)].join(" ")));
    }
    if (pictureError) found.push(fix(componentError(PICTURES, pictureError).message));
    if (backupsDir) {
      found.push(diskFinding(diskSpace(backupsDir)));
      const newest = listSnapshots(backupsDir).find(({ kind }) => kind === "daily");
      const setup = await getSetting(orm, "setup");
      const since = newest?.takenAt ?? setup?.completed_at ?? now();
      if (now() - since > COPY_OVERDUE_MS) {
        found.push(
          look(
            newest
              ? `Tend saves a copy of the site's data each day, but the newest is from ${formatDay(newest.takenAt)}. What Tend prints as it runs says why.`
              : "Tend saves a copy of the site's data each day, but there are none yet. What Tend prints as it runs says why.",
          ),
        );
      } else if (newest) {
        found.push(ok(`The newest copy of the site's data is from ${formatDay(newest.takenAt)}.`));
      }
    }
    const { themeId } = await settingValue(orm, "design");
    const theme = themes.list().find((each) => each.id === themeId);
    if (!theme) found.push(fix(`The theme this site uses, ${themeId}, isn't here any more.`));
    else if (theme.problem)
      found.push(fix(`The theme ${theme.name} has a mistake: ${theme.problem}`));
    found.push(
      nodeFinding(process.versions.node, now(), platform),
      ...addressFindings({ publicUrl: address.setUrl, trustProxy: options.trustProxy ?? 0 }),
    );
    if (!address.setUrl && address.isPublic && address.url?.startsWith("http:")) {
      found.push(
        look(
          "The site's address starts with http:, so passwords can be read on their way to it. Give it https, then open Overview there and use the new address.",
        ),
      );
    }
    return found;
  }

  route("get", "/health", "settings:manage", async (c) => {
    const { dbPath } = options;
    return c.json({
      version: options.version ?? "unknown",
      node: process.versions.node,
      platform,
      system: `${process.platform} ${process.arch}`,
      runningForSeconds: Math.floor(process.uptime()),
      memoryBytes: process.memoryUsage.rss(),
      databaseBytes: dbPath ? sizeOf(dbPath) : null,
      findings: (await findings()).map(({ kind, text }) => ({
        kind,
        text: withoutHome(text, homedir()),
      })),
    });
  });
}
