import type { RunResult } from "better-sqlite3";
import { and, asc, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { ApiError } from "../api/errors.ts";
import { foldForSearch, type Orm } from "../db/client.ts";
import type * as schema from "../db/schema.ts";
import { entries, entryTags, revisions, tags } from "../db/schema.ts";
import { uuidv7 } from "../ids.ts";
import { slugify } from "./address.ts";

export type Tag = typeof tags.$inferSelect;
type Db = BaseSQLiteDatabase<"sync", RunResult, typeof schema>;

const NAME_LIMIT = 60;

export async function listTags(orm: Orm): Promise<Tag[]> {
  return orm.select().from(tags).orderBy(asc(tags.name), asc(tags.id)).all();
}

/**
 * A tag by name. Typing an existing one again, whatever its capitals or accents, gives back
 * that one. A name in a script that addresses can't spell, like Хлеб, gets an address of
 * its own from its ID, so tags work in every language.
 */
export async function createTag(orm: Orm, input: { name: string; now: number }): Promise<Tag> {
  const name = input.name.replace(/\s+/g, " ").trim().slice(0, NAME_LIMIT);
  if (!/[\p{L}\p{N}]/u.test(name)) {
    throw new ApiError(400, "needs_fixing", "A tag needs at least one letter or number.", {
      field: "name",
      fix: "Type a word for it, like Recipes.",
    });
  }
  const folded = foldForSearch(name);
  const readable = slugify(name);
  return orm.transaction(
    (tx) => {
      const existing =
        tx.select().from(tags).where(sql`tend_fold(${tags.name}) = ${folded}`).get() ??
        (readable ? tx.select().from(tags).where(eq(tags.slug, readable)).get() : undefined);
      if (existing) return existing;
      const id = uuidv7(input.now);
      return tx
        .insert(tags)
        .values({ id, name, slug: readable || `tag-${id.slice(-8)}`, createdAt: input.now })
        .returning()
        .get();
    },
    { behavior: "immediate" },
  );
}

/** The ones that still exist, once each, in the order given. */
export async function existingTagIds(orm: Orm, ids: string[]): Promise<string[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  const found = new Set(
    orm
      .select({ id: tags.id })
      .from(tags)
      .where(inArray(tags.id, unique))
      .all()
      .map((row) => row.id),
  );
  return unique.filter((id) => found.has(id));
}

/** The tags visitors see on something: what its published version had. */
export function syncLiveTags(db: Db, entryId: string, tagIds: readonly string[]): void {
  db.delete(entryTags).where(eq(entryTags.entryId, entryId)).run();
  const unique = [...new Set(tagIds)];
  if (unique.length === 0) return;
  const existing = db.select({ id: tags.id }).from(tags).where(inArray(tags.id, unique)).all();
  if (existing.length === 0) return;
  db.insert(entryTags)
    .values(existing.map((row) => ({ entryId, tagId: row.id })))
    .run();
}

export async function findTag(orm: Orm, slug: string): Promise<Tag | undefined> {
  return orm.select().from(tags).where(eq(tags.slug, slug)).get();
}

const liveWithTag = (tagId: string) =>
  and(
    eq(entryTags.tagId, tagId),
    eq(entries.status, "published"),
    isNull(entries.trashedAt),
    eq(entries.type, "post"),
  );

export async function countLivePostsWithTag(orm: Orm, tagId: string): Promise<number> {
  const row = orm
    .select({ total: count() })
    .from(entryTags)
    .innerJoin(entries, eq(entryTags.entryId, entries.id))
    .where(liveWithTag(tagId))
    .get();
  return row?.total ?? 0;
}

/** Published posts with a tag, newest first, as their published versions. */
export async function listLivePostIdsWithTag(
  orm: Orm,
  input: { tagId: string; offset: number; limit: number },
): Promise<string[]> {
  return orm
    .select({ id: entries.id })
    .from(entryTags)
    .innerJoin(entries, eq(entryTags.entryId, entries.id))
    .innerJoin(revisions, eq(entries.publishedRevId, revisions.id))
    .where(liveWithTag(input.tagId))
    .orderBy(desc(entries.firstPublishedAt), desc(entries.id))
    .limit(input.limit)
    .offset(input.offset)
    .all()
    .map((row) => row.id);
}

/** The tags on each of these, for showing under posts. */
export async function liveTagsFor(orm: Orm, entryIds: string[]): Promise<Map<string, Tag[]>> {
  const found = new Map<string, Tag[]>();
  if (entryIds.length === 0) return found;
  const rows = orm
    .select({ entryId: entryTags.entryId, tag: tags })
    .from(entryTags)
    .innerJoin(tags, eq(entryTags.tagId, tags.id))
    .where(inArray(entryTags.entryId, entryIds))
    .orderBy(asc(tags.name))
    .all();
  for (const row of rows) found.set(row.entryId, [...(found.get(row.entryId) ?? []), row.tag]);
  return found;
}

/**
 * Tags that a published post uses, for the sitemap and the menu's Add link. Only posts count,
 * because a tag's page lists only posts: one counted for a page would be listed, and lead to
 * an empty page that asks search engines to leave it out.
 */
export async function usedTags(orm: Orm): Promise<Tag[]> {
  return orm
    .selectDistinct({
      id: tags.id,
      name: tags.name,
      slug: tags.slug,
      description: tags.description,
      createdAt: tags.createdAt,
    })
    .from(tags)
    .innerJoin(entryTags, eq(entryTags.tagId, tags.id))
    .innerJoin(entries, eq(entryTags.entryId, entries.id))
    .where(
      and(eq(entries.status, "published"), isNull(entries.trashedAt), eq(entries.type, "post")),
    )
    .orderBy(asc(tags.name))
    .all();
}
