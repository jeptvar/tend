import type { RunResult } from "better-sqlite3";
import { and, count, desc, eq, gt, isNotNull, isNull, ne, or } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { ApiError } from "../api/errors.ts";
import type { Orm } from "../db/client.ts";
import type * as schema from "../db/schema.ts";
import { entries, revisions } from "../db/schema.ts";
import { uuidv7 } from "../ids.ts";
import { entryPath, isReservedPageAddress, slugify } from "./address.ts";
import { type Doc, type EntryData, newEntryData } from "./doc.ts";
import { renderDoc } from "./render-doc.ts";

export type EntryType = "post" | "page";
export type Entry = typeof entries.$inferSelect;

/** Either the database itself or a transaction on it. */
type Db = BaseSQLiteDatabase<"sync", RunResult, typeof schema>;

export interface EntryPatch {
  title?: string | undefined;
  slug?: string | undefined;
  doc?: Doc | undefined;
  summary?: string | null | undefined;
  /** Replacing someone else's version on purpose: it's kept as a revision first. */
  keepOtherVersion?: boolean | undefined;
}

export type SaveResult = { saved: Entry } | { conflict: Entry };

function entryData(entry: Entry): EntryData {
  return entry.data as EntryData;
}

function fetchEntry(db: Db, id: string): Entry | undefined {
  return db.select().from(entries).where(eq(entries.id, id)).get();
}

function requireEntry(db: Db, id: string): Entry {
  const entry = fetchEntry(db, id);
  if (!entry) {
    throw new ApiError(404, "not_found", "That's no longer here.", { fix: "Go back to the list." });
  }
  return entry;
}

function reservedAddress(slug: string): ApiError {
  return new ApiError(400, "address_reserved", `Tend uses the address /${slug} itself.`, {
    field: "slug",
    fix: `Try ${slug}-page.`,
  });
}

function requireCurrentRev(entry: Entry, expectedRev: number): void {
  if (entry.rev !== expectedRev) {
    throw new ApiError(409, "edit_conflict", "This changed somewhere else while you had it open.", {
      fix: "Open it again to get the newest version.",
    });
  }
}

export async function createEntry(
  orm: Orm,
  input: { type: EntryType; authorId: string; now: number },
): Promise<Entry> {
  const id = uuidv7(input.now);
  orm
    .insert(entries)
    .values({
      id,
      type: input.type,
      data: newEntryData(),
      authorId: input.authorId,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .run();
  return requireEntry(orm, id);
}

export async function getEntry(orm: Orm, id: string): Promise<Entry | undefined> {
  return fetchEntry(orm, id);
}

export async function listEntries(
  orm: Orm,
  input: {
    type: EntryType;
    trashed: boolean;
    /** When set, only this person's entries. */
    authorId: string | undefined;
    offset: number;
    limit: number;
  },
): Promise<Entry[]> {
  return orm
    .select()
    .from(entries)
    .where(
      and(
        eq(entries.type, input.type),
        input.trashed ? isNotNull(entries.trashedAt) : isNull(entries.trashedAt),
        // Pressing New post and going straight back shouldn't leave an Untitled row behind,
        // so nothing appears until it's been saved once.
        or(gt(entries.rev, 1), isNotNull(entries.firstPublishedAt)),
        input.authorId ? eq(entries.authorId, input.authorId) : undefined,
      ),
    )
    .orderBy(desc(entries.isHome), desc(entries.updatedAt), desc(entries.id))
    .limit(input.limit)
    .offset(input.offset)
    .all();
}

/** Someone following "Try /blog/same-2" may type all of it, not just the last part. */
function withoutPathPrefix(type: string, typed: string): string {
  const path = typed.trim().replace(/^\/+/, "");
  return type === "post" ? path.replace(/^blog\//, "") : path;
}

/**
 * Saves the working copy. If someone else saved first, nothing is overwritten and
 * the version that lost is kept as a revision, so it can't just vanish.
 */
export async function saveEntry(
  orm: Orm,
  input: {
    id: string;
    expectedRev: number;
    patch: EntryPatch;
    authorId: string;
    now: number;
  },
): Promise<SaveResult> {
  return orm.transaction(
    (tx): SaveResult => {
      const entry = requireEntry(tx, input.id);
      const { patch } = input;
      const data = entryData(entry);
      const nextData: EntryData = {
        ...data,
        doc: patch.doc ?? data.doc,
        summary: patch.summary === undefined ? data.summary : patch.summary,
      };
      const title = patch.title === undefined ? entry.title : patch.title.trim();
      const slug =
        patch.slug === undefined ? entry.slug : slugify(withoutPathPrefix(entry.type, patch.slug));

      if (entry.rev !== input.expectedRev) {
        // The same words again: the answer to an earlier save was lost on the way back,
        // so there's no conflict to raise and nothing to keep.
        if (
          title === entry.title &&
          slug === entry.slug &&
          JSON.stringify(nextData) === JSON.stringify(data)
        ) {
          return { saved: entry };
        }
        tx.insert(revisions)
          .values({
            id: uuidv7(input.now),
            entryId: entry.id,
            kind: "conflict",
            title,
            slug,
            data: nextData,
            authorId: input.authorId,
            createdAt: input.now,
          })
          .run();
        return { conflict: entry };
      }
      if (entry.type === "page" && slug && isReservedPageAddress(slug)) {
        throw reservedAddress(slug);
      }

      if (patch.keepOtherVersion) {
        tx.insert(revisions)
          .values({
            id: uuidv7(input.now),
            entryId: entry.id,
            kind: "conflict",
            title: entry.title,
            slug: entry.slug,
            data,
            authorId: entry.authorId,
            createdAt: input.now,
          })
          .run();
      }

      tx.update(entries)
        .set({
          title,
          slug,
          data: nextData,
          rev: entry.rev + 1,
          // Only a page visitors can see can have changes that "aren't on the site yet".
          dirty: entry.liveSlug === null ? 0 : 1,
          updatedAt: input.now,
        })
        .where(eq(entries.id, entry.id))
        .run();
      return { saved: requireEntry(tx, entry.id) };
    },
    { behavior: "immediate" },
  );
}

/** Puts the working copy on the site. Runs inside a transaction: see publishEntry. */
function publishInTransaction(
  db: Db,
  entry: Entry,
  input: { authorId: string | null; now: number },
): Entry {
  const title = entry.title.trim();
  if (title === "") {
    throw new ApiError(400, "needs_fixing", "Give this a title before publishing.", {
      field: "title",
    });
  }
  // Non-Latin titles can leave nothing usable, and an address still has to exist.
  const slug = entry.slug || slugify(title) || `${entry.type}-${entry.id.slice(-8)}`;
  if (entry.type === "page" && isReservedPageAddress(slug)) throw reservedAddress(slug);

  const taken = db
    .select({ id: entries.id })
    .from(entries)
    .where(and(eq(entries.type, entry.type), eq(entries.liveSlug, slug), ne(entries.id, entry.id)))
    .get();
  if (taken) {
    const path = entryPath({ type: entry.type, isHome: 0, slug });
    throw new ApiError(409, "address_taken", `Another page already uses the address ${path}.`, {
      field: "slug",
      fix: `Try ${slug}-2.`,
    });
  }

  const data = entryData(entry);
  const { html, text } = renderDoc(data.doc);
  const revisionId = uuidv7(input.now);
  db.insert(revisions)
    .values({
      id: revisionId,
      entryId: entry.id,
      kind: "publish",
      title,
      slug,
      data,
      html,
      text,
      authorId: input.authorId,
      createdAt: input.now,
    })
    .run();
  db.update(entries)
    .set({
      status: "published",
      title,
      slug,
      liveSlug: slug,
      publishedRevId: revisionId,
      dirty: 0,
      rev: entry.rev + 1,
      firstPublishedAt: entry.firstPublishedAt ?? input.now,
      updatedAt: input.now,
    })
    .where(eq(entries.id, entry.id))
    .run();
  return requireEntry(db, entry.id);
}

export async function publishEntry(
  orm: Orm,
  input: { id: string; expectedRev: number; authorId: string; now: number },
): Promise<Entry> {
  return orm.transaction(
    (tx) => {
      const entry = requireEntry(tx, input.id);
      requireCurrentRev(entry, input.expectedRev);
      if (entry.trashedAt !== null) {
        throw new ApiError(409, "in_trash", "This is in the Trash.", {
          fix: "Restore it before publishing.",
        });
      }
      return publishInTransaction(tx, entry, input);
    },
    { behavior: "immediate" },
  );
}

function offTheSite(now: number, entry: Entry) {
  return {
    status: "draft" as const,
    liveSlug: null,
    publishedRevId: null,
    dirty: 0,
    rev: entry.rev + 1,
    updatedAt: now,
  };
}

function refuseForHome(entry: Entry, doing: string): void {
  if (entry.isHome === 1) {
    throw new ApiError(409, "is_homepage", `Your homepage can't be ${doing}.`, {
      fix: "Edit it instead.",
    });
  }
}

export async function unpublishEntry(
  orm: Orm,
  input: { id: string; expectedRev: number; now: number },
): Promise<Entry> {
  return orm.transaction(
    (tx) => {
      const entry = requireEntry(tx, input.id);
      requireCurrentRev(entry, input.expectedRev);
      refuseForHome(entry, "unpublished");
      tx.update(entries).set(offTheSite(input.now, entry)).where(eq(entries.id, entry.id)).run();
      return requireEntry(tx, entry.id);
    },
    { behavior: "immediate" },
  );
}

/** Moving something to the Trash also takes it off the site, freeing its address. */
export async function trashEntry(orm: Orm, input: { id: string; now: number }): Promise<Entry> {
  return orm.transaction(
    (tx) => {
      const entry = requireEntry(tx, input.id);
      refuseForHome(entry, "moved to the Trash");
      tx.update(entries)
        .set({ ...offTheSite(input.now, entry), trashedAt: input.now })
        .where(eq(entries.id, entry.id))
        .run();
      return requireEntry(tx, entry.id);
    },
    { behavior: "immediate" },
  );
}

/** Comes back as a draft: going back on the site should be a decision, not a side effect. */
export async function restoreEntry(orm: Orm, input: { id: string; now: number }): Promise<Entry> {
  return orm.transaction(
    (tx) => {
      const entry = requireEntry(tx, input.id);
      tx.update(entries)
        .set({ trashedAt: null, rev: entry.rev + 1, updatedAt: input.now })
        .where(eq(entries.id, entry.id))
        .run();
      return requireEntry(tx, entry.id);
    },
    { behavior: "immediate" },
  );
}

/** What lists need to know about something published. */
export interface LiveSummary {
  type: string;
  title: string;
  slug: string;
  text: string;
  summary: string | null;
  firstPublishedAt: number | null;
}

/** What visitors see: the published version, never the working copy. */
export interface LiveEntry extends LiveSummary {
  isHome: number;
  html: string;
}

const SUMMARY_FIELDS = {
  type: entries.type,
  title: revisions.title,
  slug: revisions.slug,
  text: revisions.text,
  data: revisions.data,
  firstPublishedAt: entries.firstPublishedAt,
};

const ENTRY_FIELDS = { ...SUMMARY_FIELDS, isHome: entries.isHome, html: revisions.html };

function toSummary(row: {
  type: string;
  title: string;
  slug: string;
  text: string | null;
  data: unknown;
  firstPublishedAt: number | null;
}): LiveSummary {
  return {
    type: row.type,
    title: row.title,
    slug: row.slug,
    text: row.text ?? "",
    summary: (row.data as EntryData).summary,
    firstPublishedAt: row.firstPublishedAt,
  };
}

const isLive = and(eq(entries.status, "published"), isNull(entries.trashedAt));

export async function findLiveEntry(
  orm: Orm,
  type: EntryType,
  slug: string,
): Promise<LiveEntry | undefined> {
  const row = orm
    .select(ENTRY_FIELDS)
    .from(entries)
    .innerJoin(revisions, eq(revisions.id, entries.publishedRevId))
    .where(and(isLive, eq(entries.type, type), eq(entries.liveSlug, slug)))
    .get();
  return row && { ...toSummary(row), isHome: row.isHome, html: row.html ?? "" };
}

export async function findLiveHome(orm: Orm): Promise<LiveEntry | undefined> {
  const row = orm
    .select(ENTRY_FIELDS)
    .from(entries)
    .innerJoin(revisions, eq(revisions.id, entries.publishedRevId))
    .where(and(isLive, eq(entries.isHome, 1)))
    .get();
  return row && { ...toSummary(row), isHome: row.isHome, html: row.html ?? "" };
}

export async function findLiveHomeSlug(orm: Orm): Promise<string | undefined> {
  const row = orm
    .select({ liveSlug: entries.liveSlug })
    .from(entries)
    .where(and(isLive, eq(entries.isHome, 1)))
    .get();
  return row?.liveSlug ?? undefined;
}

export async function listLivePosts(
  orm: Orm,
  input: { offset: number; limit: number },
): Promise<LiveSummary[]> {
  return orm
    .select(SUMMARY_FIELDS)
    .from(entries)
    .innerJoin(revisions, eq(revisions.id, entries.publishedRevId))
    .where(and(isLive, eq(entries.type, "post")))
    .orderBy(desc(entries.firstPublishedAt), desc(entries.id))
    .limit(input.limit)
    .offset(input.offset)
    .all()
    .map(toSummary);
}

export async function countLivePosts(orm: Orm): Promise<number> {
  const row = orm
    .select({ total: count() })
    .from(entries)
    .where(and(isLive, eq(entries.type, "post")))
    .get();
  return row?.total ?? 0;
}

/** The pages for the site's menu, until the real Site menu arrives (M3). Titles only. */
export async function listMenuPages(orm: Orm): Promise<{ title: string; slug: string }[]> {
  return orm
    .select({ title: revisions.title, slug: revisions.slug })
    .from(entries)
    .innerJoin(revisions, eq(revisions.id, entries.publishedRevId))
    .where(and(isLive, eq(entries.type, "page"), eq(entries.isHome, 0)))
    .orderBy(revisions.title)
    .all();
}

export interface StarterEntry {
  type: EntryType;
  title: string;
  slug: string;
  isHome?: boolean;
  body: string;
}

/** Creates a starting point's example content, already published. Part of setup's transaction. */
export function seedStarterEntries(
  db: Db,
  input: {
    entries: StarterEntry[];
    toDoc: (body: string) => Doc;
    authorId: string;
    now: number;
  },
): void {
  for (const starter of input.entries) {
    const id = uuidv7(input.now);
    db.insert(entries)
      .values({
        id,
        type: starter.type,
        title: starter.title,
        slug: starter.slug,
        isHome: starter.isHome ? 1 : 0,
        isExample: 1,
        data: newEntryData(input.toDoc(starter.body)),
        authorId: input.authorId,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .run();
    publishInTransaction(db, requireEntry(db, id), input);
  }
}
