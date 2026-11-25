import { seesOnlyOwnEntries } from "../../auth/policy.ts";
import { listSnapshots } from "../../backups/snapshots.ts";
import { countEntries, type EntryView, listEntries } from "../../content/entries.ts";
import {
  hasUploaded,
  homeId,
  homeIsEdited,
  ownPostPublished,
  recentActivity,
} from "../../content/overview.ts";
import { settingValue } from "../../content/settings.ts";
import { getSetting } from "../../db/repo/settings.ts";
import { recoveryKitSaved } from "../../db/repo/tokens.ts";
import type { User } from "../../db/repo/users.ts";
import { diskSpace, isRunningLow } from "../../disk.ts";
import { isHostingAddress } from "../../site-address.ts";
import { listJson } from "./entries.ts";
import type { AdminOptions, Routing } from "./routing.ts";

/** How many of each list Overview shows. The rest are a link away. */
const SHOWN = 5;
const ACTIVITY_SHOWN = 8;

export interface OverviewRouteOptions extends AdminOptions {
  /** Where the copies Tend makes are kept. Absent only in tests that don't need it. */
  backupsDir?: string | undefined;
}

export type StepId = "home" | "business" | "post" | "logo" | "photo" | "kit" | "online" | "domain";

export interface Step {
  id: StepId;
  done: boolean;
}

/** Overview (PLAN.md §6): what's waiting, the first steps, and what's been happening. */
export function registerOverviewRoutes(routing: Routing, options: OverviewRouteOptions): void {
  const { orm, address } = options;
  const { now, route } = routing;

  /** The first steps for someone with this role, which tick themselves off. */
  async function steps(user: User): Promise<Step[]> {
    const kit: Step = { id: "kit", done: recoveryKitSaved(orm, user, now()) };
    if (user.role !== "admin") {
      return [
        kit,
        { id: "post", done: ownPostPublished(orm, user.id) },
        { id: "photo", done: hasUploaded(orm, user.id) },
      ];
    }
    const setup = await getSetting(orm, "setup");
    const list: Step[] = [{ id: "home", done: homeIsEdited(orm) }];
    if (setup?.starter === "business") {
      const business = await settingValue(orm, "business");
      list.push({
        id: "business",
        done: Object.values(business).some((value) => value !== null),
      });
    }
    if (setup?.starter === "blog") list.push({ id: "post", done: ownPostPublished(orm) });
    const design = await settingValue(orm, "design");
    list.push({ id: "logo", done: design.logoId !== null }, kit);
    const { url } = address;
    if (!url || !address.isPublic) list.push({ id: "online", done: false });
    else list.push({ id: "domain", done: !isHostingAddress(url) });
    return list;
  }

  route("get", "/overview", "entry:list", async (c, user) => {
    const authorId = seesOnlyOwnEntries(user) ? user.id : undefined;
    const part = async (view: EntryView) =>
      listJson(orm, await listEntries(orm, { view, authorId, offset: 0, limit: SHOWN }));
    const counts = await countEntries(orm, { authorId });
    const setup = await getSetting(orm, "setup");
    const isAdmin = user.role === "admin";
    const { backupsDir } = options;
    const disk = isAdmin && backupsDir ? diskSpace(backupsDir) : null;
    return c.json({
      homeId: homeId(orm),
      changes: { entries: await part("changes"), count: counts.changes },
      drafts: { entries: await part("drafts"), count: counts.drafts },
      steps: await steps(user),
      activity: recentActivity(orm, {
        viewer: user,
        setUpAt: setup?.completed_at ?? 0,
        limit: ACTIVITY_SHOWN,
        now: now(),
      }),
      // For whoever can do something about it.
      disk: disk && { ...disk, low: isRunningLow(disk) },
      lastCopyAt: isAdmin && backupsDir ? (listSnapshots(backupsDir)[0]?.takenAt ?? null) : null,
    });
  });
}
