import { and, desc, eq, gt, inArray, isNotNull, isNull, or } from "drizzle-orm";
import type { Orm } from "../db/client.ts";
import { entries, media, revisions, settings, users } from "../db/schema.ts";
import { firstIdAt } from "../ids.ts";
import type { SettingKey } from "./settings.ts";

// What Overview shows (PLAN.md §6): what's been happening, and which of the first steps are
// done. All of it comes from what's kept anyway, so nothing has to be written down for it.

const DAY_MS = 24 * 60 * 60 * 1000;
/** How far back recent activity goes. */
const RECENT_DAYS = 30;
/** Photos added one after another by the same person count as one thing that happened. */
const TOGETHER_MS = 60 * 60 * 1000;
/** Enough that repeats of the same thing can be left out, and there's still some to show. */
const LOOKED_AT = 60;

/** The settings whose changes are worth telling, and who each is for. */
const TOLD: Record<Exclude<SettingKey, never>, "everyone" | "admins"> = {
  "menu:main": "everyone",
  "menu:footer": "everyone",
  site: "admins",
  business: "admins",
  visibility: "admins",
  seo: "admins",
  design: "admins",
  code_injection: "admins",
};

export interface Activity {
  id: string;
  kind: "published" | "changed" | "added" | "setting" | "joined";
  at: number;
  /** Who it was. Null if that isn't known, or they've been removed since. */
  by: string | null;
  /** The post or page that was published or changed. */
  entry?: { id: string; type: string; title: string };
  /** How many photos and files were added. */
  count?: number;
  /** Which setting was changed. */
  setting?: string;
}

export interface Viewer {
  id: string;
  role: string;
}

/** The last few things that happened, newest first, that this person may know about. */
export function recentActivity(
  orm: Orm,
  input: { viewer: Viewer; setUpAt: number; limit: number; now: number },
): Activity[] {
  const { viewer } = input;
  // What setup made itself isn't something anyone did.
  const since = Math.max(input.setUpAt, input.now - RECENT_DAYS * DAY_MS);
  const onlyOwn = viewer.role === "writer" ? viewer.id : undefined;
  const names = new Map(
    orm
      .select({ id: users.id, name: users.name })
      .from(users)
      .all()
      .map((row) => [row.id, row.name]),
  );
  const nameOf = (id: string | null) => (id === null ? null : (names.get(id) ?? null));

  // Versions are found by their ids, which sort by when they were made. Their times come
  // after the words in each row, so looking there would mean reading every version's words.
  const published = new Map<string, Activity>();
  for (const row of orm
    .select({
      id: revisions.id,
      entryId: revisions.entryId,
      title: revisions.title,
      by: revisions.authorId,
      at: revisions.createdAt,
      type: entries.type,
      firstAt: entries.firstPublishedAt,
    })
    .from(revisions)
    .innerJoin(entries, eq(entries.id, revisions.entryId))
    .where(
      and(
        gt(revisions.id, firstIdAt(since + 1)),
        eq(revisions.kind, "publish"),
        isNull(entries.trashedAt),
        onlyOwn ? eq(entries.authorId, onlyOwn) : undefined,
      ),
    )
    .orderBy(desc(revisions.id))
    .limit(LOOKED_AT)
    .all()) {
    // Publishing the same page again and again is told once, as of the last time.
    if (published.has(row.entryId)) continue;
    published.set(row.entryId, {
      id: row.id,
      kind: row.at === row.firstAt ? "published" : "changed",
      at: row.at,
      by: nameOf(row.by),
      entry: { id: row.entryId, type: row.type, title: row.title },
    });
  }

  const added: Activity[] = [];
  let group: { activity: Activity; by: string | null; from: number } | undefined;
  for (const row of orm
    .select({ id: media.id, by: media.uploadedBy, at: media.createdAt })
    .from(media)
    .where(
      and(
        gt(media.createdAt, since),
        isNull(media.trashedAt),
        onlyOwn ? eq(media.uploadedBy, onlyOwn) : undefined,
      ),
    )
    .orderBy(desc(media.createdAt), desc(media.id))
    .all()) {
    if (group && group.by === row.by && group.from - row.at < TOGETHER_MS) {
      group.activity.count = (group.activity.count ?? 0) + 1;
      group.from = row.at;
      continue;
    }
    const activity: Activity = {
      id: row.id,
      kind: "added",
      at: row.at,
      by: nameOf(row.by),
      count: 1,
    };
    group = { activity, by: row.by, from: row.at };
    added.push(activity);
  }

  const told = Object.keys(TOLD).filter(
    (key) =>
      viewer.role === "admin" ||
      (viewer.role === "editor" && TOLD[key as SettingKey] === "everyone"),
  );
  const changed: Activity[] = orm
    .select()
    .from(settings)
    .where(and(inArray(settings.key, told), gt(settings.updatedAt, since)))
    .all()
    .map((row) => ({
      id: row.key,
      kind: "setting",
      at: row.updatedAt,
      by: nameOf(row.updatedBy),
      setting: row.key,
    }));

  const joined: Activity[] =
    viewer.role !== "admin"
      ? []
      : orm
          .select({ id: users.id, name: users.name, at: users.createdAt })
          .from(users)
          .where(gt(users.createdAt, since))
          .all()
          .map((row) => ({ id: row.id, kind: "joined", at: row.at, by: row.name }));

  return [...published.values(), ...added, ...changed, ...joined]
    .sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1))
    .slice(0, input.limit);
}

export function homeId(orm: Orm): string | null {
  const home = orm.select({ id: entries.id }).from(entries).where(eq(entries.isHome, 1)).get();
  return home?.id ?? null;
}

/** Whether the homepage on the site is someone's own, rather than the one it started with. */
export function homeIsEdited(orm: Orm): boolean {
  const home = orm
    .select({ madeAt: entries.createdAt, liveAt: revisions.createdAt })
    .from(entries)
    .innerJoin(revisions, eq(revisions.id, entries.publishedRevId))
    .where(eq(entries.isHome, 1))
    .get();
  return home !== undefined && home.liveAt > home.madeAt;
}

/**
 * Whether a post of someone's own has been published: not one of the examples a site starts
 * with, unless it was made into something else and published again.
 */
export function ownPostPublished(orm: Orm, authorId?: string): boolean {
  const post = orm
    .select({ id: entries.id })
    .from(entries)
    .leftJoin(revisions, eq(revisions.id, entries.publishedRevId))
    .where(
      and(
        eq(entries.type, "post"),
        isNotNull(entries.firstPublishedAt),
        authorId ? eq(entries.authorId, authorId) : undefined,
        or(eq(entries.isExample, 0), gt(revisions.createdAt, entries.createdAt)),
      ),
    )
    .limit(1)
    .get();
  return post !== undefined;
}

export function hasUploaded(orm: Orm, userId: string): boolean {
  return (
    orm.select({ id: media.id }).from(media).where(eq(media.uploadedBy, userId)).limit(1).get() !==
    undefined
  );
}
