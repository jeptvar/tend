import type { RunResult } from "better-sqlite3";
import { and, count, desc, eq, gt, inArray, isNotNull, isNull, lt, ne, or, sql } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { ApiError } from "../api/errors.ts";
import { foldForSearch, type Orm } from "../db/client.ts";
import type * as schema from "../db/schema.ts";
import { entries, refs, revisions, users } from "../db/schema.ts";
import { uuidv7 } from "../ids.ts";
import { entryPath, isReservedPageAddress, slugify } from "./address.ts";
import {
  type Doc,
  type EntryData,
  type FeaturedImage,
  firstImageId,
  linkedEntryIds,
  newEntryData,
  shownMediaIds,
  usedMediaIds,
} from "./doc.ts";
import { addRedirect, clearRedirectFrom } from "./redirects.ts";
import { leadText, renderDoc } from "./render-doc.ts";
import { syncLiveTags } from "./tags.ts";

export type EntryType = "post" | "page";
export type Entry = typeof entries.$inferSelect;
export type Revision = typeof revisions.$inferSelect;

const DAY_MS = 24 * 60 * 60 * 1000;
/** How long the Trash and automatic history keep things (PLAN.md §6, §8). */
export const KEEP_DAYS = 30;
/** Automatic history keeps at most one version per this long. */
const AUTOSAVE_REVISION_MS = 10 * 60 * 1000;
const COPY_PREFIX = "Copy of ";
const REF_BATCH = 500;
const TITLE_LIMIT = 200;

/** Either the database itself or a transaction on it. */
type Db = BaseSQLiteDatabase<"sync", RunResult, typeof schema>;

export interface EntryPatch {
  title?: string | undefined;
  slug?: string | undefined;
  doc?: Doc | undefined;
  summary?: string | null | undefined;
  featuredImage?: FeaturedImage | null | undefined;
  seo?: Partial<EntryData["seo"]> | undefined;
  tagIds?: string[] | undefined;
  /** Replacing someone else's version on purpose: it's kept as a revision first. */
  keepOtherVersion?: boolean | undefined;
  /** Which editor window this came from. Its own earlier saves are never a conflict. */
  editSession?: string | undefined;
  /** That window's count of what it's sent. Only something newer from it gets through. */
  editSeq?: number | undefined;
}

export type SaveResult = { saved: Entry } | { conflict: Entry };

/** The stored data, with anything a row from an older version lacks filled in. */
function entryData(entry: Pick<Entry, "data">): EntryData {
  const stored = entry.data as Partial<EntryData>;
  const blank = newEntryData();
  return {
    ...blank,
    ...stored,
    doc: stored.doc ?? blank.doc,
    seo: { ...blank.seo, ...stored.seo },
    tagIds: Array.isArray(stored.tagIds) ? stored.tagIds : [],
    featuredImage: stored.featuredImage ?? null,
  };
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

/**
 * Whether the newest version came from this same editor window, and this is newer still. A
 * window's requests can arrive out of order, so an older one held up on the way doesn't get
 * to undo what came after it.
 */
function isOwnLatest(
  entry: Entry,
  from: { editSession?: string | undefined; editSeq?: number | undefined },
): boolean {
  if (from.editSession === undefined || entry.editSession !== from.editSession) return false;
  return from.editSeq === undefined || entry.editSeq === null || from.editSeq > entry.editSeq;
}

/**
 * Anything acting on an entry has to have seen its newest version. The exception is the
 * editor window that made that version: it knows about it, and only lost the answer.
 */
function requireCurrentRev(
  entry: Entry,
  expectedRev: number,
  from: { editSession?: string | undefined; editSeq?: number | undefined } = {},
): void {
  if (entry.rev !== expectedRev && !isOwnLatest(entry, from)) {
    throw new ApiError(409, "edit_conflict", "This changed somewhere else while you had it open.", {
      fix: "Open it again to get the newest version.",
    });
  }
}

/** Records what this version links to and shows, for "used in" and for telling people what breaks. */
function syncEntryRefs(
  db: Db,
  entryId: string,
  scope: "working" | "live",
  data: Pick<EntryData, "doc" | "featuredImage" | "seo" | "tagIds"> | null,
): void {
  db.delete(refs)
    .where(and(eq(refs.entryId, entryId), eq(refs.scope, scope)))
    .run();
  // What visitors see tagged follows the published version, like everything else live.
  if (scope === "live") syncLiveTags(db, entryId, data?.tagIds ?? []);
  if (!data) return;
  const rows = [
    ...linkedEntryIds(data.doc).map((refId) => ({ entryId, scope, kind: "entry" as const, refId })),
    ...usedMediaIds(data).map((refId) => ({ entryId, scope, kind: "media" as const, refId })),
  ];
  // In batches, because one statement can only carry so many values, and a long index page
  // really can link to thousands of posts.
  for (let start = 0; start < rows.length; start += REF_BATCH) {
    db.insert(refs)
      .values(rows.slice(start, start + REF_BATCH))
      .run();
  }
}

/** Whether this working copy says exactly what visitors can see now. */
function matchesLive(
  db: Db,
  entry: Entry,
  content: Pick<Entry, "title" | "slug" | "data">,
): boolean {
  if (entry.publishedRevId === null) return false;
  const live = db.select().from(revisions).where(eq(revisions.id, entry.publishedRevId)).get();
  return (
    live !== undefined &&
    live.title === content.title &&
    live.slug === content.slug &&
    JSON.stringify(live.data) === JSON.stringify(content.data)
  );
}

function isDirty(db: Db, entry: Entry, content: Pick<Entry, "title" | "slug" | "data">): number {
  // Only something visitors can see can have changes that "aren't on the site yet".
  if (entry.liveSlug === null) return 0;
  return matchesLive(db, entry, content) ? 0 : 1;
}

function keepRevision(
  db: Db,
  input: {
    entry: Pick<Entry, "id">;
    kind: Revision["kind"];
    content: Pick<Entry, "title" | "slug" | "data">;
    authorId: string | null;
    now: number;
  },
): string {
  const id = uuidv7(input.now);
  db.insert(revisions)
    .values({
      id,
      entryId: input.entry.id,
      kind: input.kind,
      title: input.content.title,
      slug: input.content.slug,
      data: input.content.data,
      authorId: input.authorId,
      createdAt: input.now,
    })
    .run();
  return id;
}

/**
 * Keeps a version for History now and then while someone works. It's the version from just
 * before this save, because that one has stood for a while. What's being typed right now
 * hasn't, and it's only a keystroke away from the next.
 */
function keepAutomaticVersion(
  db: Db,
  entry: Entry,
  input: { authorId: string; editSession: string | undefined; now: number },
): void {
  const { now } = input;
  const untouched = entry.rev === 1 && entry.firstPublishedAt === null;
  if (untouched) return;
  if (matchesLive(db, entry, entry)) return;
  // Someone or somewhere else saved this last. They may never get to save again, so their
  // words have to survive being replaced, however recently a version was kept.
  const takingOver =
    entry.updatedBy !== input.authorId ||
    (entry.editSession !== null && entry.editSession !== input.editSession);
  const latest = takingOver
    ? undefined
    : db
        .select({ createdAt: revisions.createdAt })
        .from(revisions)
        .where(and(eq(revisions.entryId, entry.id), eq(revisions.kind, "autosave")))
        .orderBy(desc(revisions.createdAt))
        .limit(1)
        .get();
  if (latest && now - latest.createdAt < AUTOSAVE_REVISION_MS) return;
  keepRevision(db, {
    entry,
    kind: "autosave",
    content: entry,
    authorId: entry.updatedBy ?? entry.authorId,
    now,
  });
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
        featuredImage: patch.featuredImage === undefined ? data.featuredImage : patch.featuredImage,
        seo: patch.seo === undefined ? data.seo : { ...data.seo, ...patch.seo },
        tagIds: patch.tagIds ?? data.tagIds,
      };
      const title = patch.title === undefined ? entry.title : patch.title.trim();
      const slug =
        patch.slug === undefined ? entry.slug : slugify(withoutPathPrefix(entry.type, patch.slug));

      // This window saved last, so it already knows about that version. It just never
      // heard back, because the connection dropped on the way.
      const ownEarlierSave = isOwnLatest(entry, patch);
      if (entry.rev !== input.expectedRev && !ownEarlierSave) {
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
      if (patch.keepOtherVersion) {
        keepRevision(tx, {
          entry,
          kind: "conflict",
          content: entry,
          authorId: entry.updatedBy ?? entry.authorId,
          now: input.now,
        });
      } else {
        keepAutomaticVersion(tx, entry, {
          authorId: input.authorId,
          editSession: patch.editSession,
          now: input.now,
        });
      }

      tx.update(entries)
        .set({
          title,
          slug,
          data: nextData,
          rev: entry.rev + 1,
          dirty: isDirty(tx, entry, { title, slug, data: nextData }),
          updatedBy: input.authorId,
          editSession: patch.editSession ?? null,
          editSeq: patch.editSeq ?? null,
          updatedAt: input.now,
        })
        .where(eq(entries.id, entry.id))
        .run();
      syncEntryRefs(tx, entry.id, "working", nextData);
      return { saved: requireEntry(tx, entry.id) };
    },
    { behavior: "immediate" },
  );
}

/** Non-Latin titles can leave nothing usable, and an address still has to exist. */
function publishSlug(entry: Entry): string {
  return entry.slug || slugify(entry.title) || `${entry.type}-${entry.id.slice(-8)}`;
}

/**
 * Why this couldn't be published at that address, if there's a reason. Saving doesn't check
 * this, because nothing should stop someone's words being saved while they're partway
 * through typing an address. The editor shows it, and publishing refuses.
 */
function addressProblem(db: Db, entry: Entry, slug: string): ApiError | undefined {
  if (entry.type === "page" && isReservedPageAddress(slug)) return reservedAddress(slug);
  const taken = db
    .select({ id: entries.id })
    .from(entries)
    .where(and(eq(entries.type, entry.type), eq(entries.liveSlug, slug), ne(entries.id, entry.id)))
    .get();
  if (!taken) return undefined;
  const path = entryPath({ type: entry.type, isHome: 0, slug });
  return new ApiError(409, "address_taken", `Another page already uses the address ${path}.`, {
    field: "slug",
    fix: `Try ${slug}-2.`,
  });
}

/** The address publishing would use and any problem with it, for the editor to show early. */
export async function checkAddress(
  orm: Orm,
  entry: Entry,
): Promise<{ path: string; problem: ApiError | undefined }> {
  const slug = publishSlug(entry);
  return {
    path: entryPath({ type: entry.type, isHome: entry.isHome, slug }),
    problem: entry.isHome === 1 ? undefined : addressProblem(orm, entry, slug),
  };
}

/** Puts the working copy on the site. Runs inside a transaction: see publishEntry. */
function publishInTransaction(
  db: Db,
  entry: Entry,
  input: {
    authorId: string | null;
    editSession?: string | undefined;
    editSeq?: number | undefined;
    now: number;
  },
): Entry {
  const title = entry.title.trim();
  if (title === "") {
    throw new ApiError(400, "needs_fixing", "Give this a title before publishing.", {
      field: "title",
    });
  }
  const slug = publishSlug(entry);
  const problem = addressProblem(db, entry, slug);
  if (problem) throw problem;

  const data = entryData(entry);
  const { html, text } = renderDoc(data.doc);
  const revisionId = uuidv7(input.now);
  // A published address that changes leaves a way from the old one to the new (PLAN.md §9).
  const path = entryPath({ type: entry.type, isHome: entry.isHome, slug });
  if (entry.liveSlug !== null) {
    const was = entryPath({ type: entry.type, isHome: entry.isHome, slug: entry.liveSlug });
    if (was !== path) addRedirect(db, { from: was, to: path, source: "auto", now: input.now });
  }
  clearRedirectFrom(db, path);
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
      updatedBy: input.authorId,
      editSession: input.editSession ?? null,
      editSeq: input.editSeq ?? null,
      firstPublishedAt: entry.firstPublishedAt ?? input.now,
      updatedAt: input.now,
    })
    .where(eq(entries.id, entry.id))
    .run();
  syncEntryRefs(db, entry.id, "working", data);
  syncEntryRefs(db, entry.id, "live", data);
  return requireEntry(db, entry.id);
}

export async function publishEntry(
  orm: Orm,
  input: {
    id: string;
    expectedRev: number;
    editSession?: string | undefined;
    editSeq?: number | undefined;
    authorId: string;
    now: number;
  },
): Promise<Entry> {
  return orm.transaction(
    (tx) => {
      const entry = requireEntry(tx, input.id);
      requireCurrentRev(entry, input.expectedRev, input);
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

function offTheSite(
  input: {
    now: number;
    authorId: string;
    editSession?: string | undefined;
    editSeq?: number | undefined;
  },
  entry: Entry,
) {
  return {
    status: "draft" as const,
    liveSlug: null,
    publishedRevId: null,
    dirty: 0,
    rev: entry.rev + 1,
    updatedBy: input.authorId,
    editSession: input.editSession ?? null,
    editSeq: input.editSeq ?? null,
    updatedAt: input.now,
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
  input: {
    id: string;
    expectedRev: number;
    editSession?: string | undefined;
    editSeq?: number | undefined;
    authorId: string;
    now: number;
  },
): Promise<{ entry: Entry; wasLiveRevisionId: string | null }> {
  return orm.transaction(
    (tx) => {
      const entry = requireEntry(tx, input.id);
      requireCurrentRev(entry, input.expectedRev, input);
      refuseForHome(entry, "unpublished");
      // Already off: this is a second try after the answer to the first got lost. It still
      // says which version was on the site, so Undo can put it back.
      if (entry.publishedRevId === null) {
        const lastLive = tx
          .select({ id: revisions.id })
          .from(revisions)
          .where(and(eq(revisions.entryId, entry.id), eq(revisions.kind, "publish")))
          .orderBy(desc(revisions.createdAt), desc(revisions.id))
          .limit(1)
          .get();
        return { entry, wasLiveRevisionId: lastLive?.id ?? null };
      }
      tx.update(entries).set(offTheSite(input, entry)).where(eq(entries.id, entry.id)).run();
      syncEntryRefs(tx, entry.id, "live", null);
      return { entry: requireEntry(tx, entry.id), wasLiveRevisionId: entry.publishedRevId };
    },
    { behavior: "immediate" },
  );
}

/**
 * Undoes Unpublish: the same version goes back on the site, at the same address. Publishing
 * again would be wrong, because the working copy may hold changes nobody has reviewed.
 */
export async function undoUnpublish(
  orm: Orm,
  input: {
    id: string;
    revisionId: string;
    expectedRev: number;
    editSession?: string | undefined;
    editSeq?: number | undefined;
    authorId: string;
    now: number;
  },
): Promise<Entry> {
  return orm.transaction(
    (tx) => {
      const entry = requireEntry(tx, input.id);
      requireCurrentRev(entry, input.expectedRev, input);
      // Something else has gone on the site since, and that isn't this Undo's to replace.
      if (entry.publishedRevId !== null) {
        throw new ApiError(409, "already_on_site", "This is already back on your site.", {
          fix: "Use History if you want an earlier version.",
        });
      }
      const live = tx.select().from(revisions).where(eq(revisions.id, input.revisionId)).get();
      if (!live || live.entryId !== entry.id || live.kind !== "publish") {
        throw new ApiError(404, "not_found", "That version is no longer here.", {
          fix: "Publish it again instead.",
        });
      }
      if (entry.trashedAt !== null) {
        throw new ApiError(409, "in_trash", "This is in the Trash.", {
          fix: "Restore it before publishing.",
        });
      }
      const problem = addressProblem(tx, entry, live.slug);
      if (problem) throw problem;
      const same =
        live.title === entry.title &&
        live.slug === entry.slug &&
        JSON.stringify(live.data) === JSON.stringify(entry.data);
      tx.update(entries)
        .set({
          status: "published",
          liveSlug: live.slug,
          publishedRevId: live.id,
          dirty: same ? 0 : 1,
          rev: entry.rev + 1,
          updatedBy: input.authorId,
          editSession: input.editSession ?? null,
          editSeq: input.editSeq ?? null,
          updatedAt: input.now,
        })
        .where(eq(entries.id, entry.id))
        .run();
      syncEntryRefs(tx, entry.id, "live", entryData(live));
      return requireEntry(tx, entry.id);
    },
    { behavior: "immediate" },
  );
}

/** Moving something to the Trash also takes it off the site, freeing its address. */
export async function trashEntry(
  orm: Orm,
  input: { id: string; authorId: string; now: number },
): Promise<Entry> {
  return orm.transaction(
    (tx) => {
      const entry = requireEntry(tx, input.id);
      refuseForHome(entry, "moved to the Trash");
      tx.update(entries)
        .set({ ...offTheSite(input, entry), trashedAt: input.now })
        .where(eq(entries.id, entry.id))
        .run();
      syncEntryRefs(tx, entry.id, "live", null);
      return requireEntry(tx, entry.id);
    },
    { behavior: "immediate" },
  );
}

/** Comes back as a draft: going back on the site should be a decision, not a side effect. */
export async function restoreEntry(
  orm: Orm,
  input: { id: string; authorId: string; now: number },
): Promise<Entry> {
  return orm.transaction(
    (tx) => {
      const entry = requireEntry(tx, input.id);
      tx.update(entries)
        .set({
          trashedAt: null,
          rev: entry.rev + 1,
          updatedBy: input.authorId,
          editSession: null,
          editSeq: null,
          updatedAt: input.now,
        })
        .where(eq(entries.id, entry.id))
        .run();
      return requireEntry(tx, entry.id);
    },
    { behavior: "immediate" },
  );
}

/** Goes back to what's on the site. What was being worked on is kept in History. */
export async function discardChanges(
  orm: Orm,
  input: {
    id: string;
    expectedRev: number;
    editSession?: string | undefined;
    editSeq?: number | undefined;
    authorId: string;
    now: number;
  },
): Promise<{ entry: Entry; keptRevisionId: string }> {
  return orm.transaction(
    (tx) => {
      const entry = requireEntry(tx, input.id);
      requireCurrentRev(entry, input.expectedRev, input);
      const live =
        entry.publishedRevId === null
          ? undefined
          : tx.select().from(revisions).where(eq(revisions.id, entry.publishedRevId)).get();
      if (!live) {
        throw new ApiError(
          409,
          "not_on_site",
          "This isn't on your site, so there's nothing to go back to.",
        );
      }
      const keptRevisionId = keepRevision(tx, {
        entry,
        kind: "before_discard",
        content: entry,
        authorId: input.authorId,
        now: input.now,
      });
      const data = entryData(live);
      tx.update(entries)
        .set({
          title: live.title,
          slug: live.slug,
          data,
          dirty: 0,
          rev: entry.rev + 1,
          updatedBy: input.authorId,
          editSession: input.editSession ?? null,
          editSeq: input.editSeq ?? null,
          updatedAt: input.now,
        })
        .where(eq(entries.id, entry.id))
        .run();
      syncEntryRefs(tx, entry.id, "working", data);
      return { entry: requireEntry(tx, entry.id), keptRevisionId };
    },
    { behavior: "immediate" },
  );
}

/** Makes a new draft with the same words. It starts with its own address and isn't on the site. */
export async function duplicateEntry(
  orm: Orm,
  input: { id: string; authorId: string; now: number },
): Promise<Entry> {
  return orm.transaction(
    (tx) => {
      const original = requireEntry(tx, input.id);
      const data = entryData(original);
      const id = uuidv7(input.now);
      tx.insert(entries)
        .values({
          id,
          type: original.type,
          title: `${COPY_PREFIX}${original.title}`.slice(0, TITLE_LIMIT).trim(),
          data,
          // Past the first version, so it shows up in lists straight away.
          rev: 2,
          authorId: input.authorId,
          updatedBy: input.authorId,
          createdAt: input.now,
          updatedAt: input.now,
        })
        .run();
      syncEntryRefs(tx, id, "working", data);
      return requireEntry(tx, id);
    },
    { behavior: "immediate" },
  );
}

/** Only from the Trash, so nothing on the site can disappear in one step. Can't be undone. */
export async function deleteEntryForever(orm: Orm, input: { id: string }): Promise<void> {
  orm.transaction(
    (tx) => {
      const entry = requireEntry(tx, input.id);
      if (entry.trashedAt === null) {
        throw new ApiError(
          409,
          "not_in_trash",
          "Only something in the Trash can be deleted forever.",
          {
            fix: "Move it to the Trash first.",
          },
        );
      }
      // Other versions and the record of what it links to go with it. What links to it
      // shows as plain text, the same as a page that's been unpublished.
      tx.delete(refs)
        .where(and(eq(refs.kind, "entry"), eq(refs.refId, entry.id)))
        .run();
      tx.delete(entries).where(eq(entries.id, entry.id)).run();
    },
    { behavior: "immediate" },
  );
}

export interface RevisionSummary {
  id: string;
  kind: Revision["kind"];
  title: string;
  authorName: string | null;
  createdAt: number;
  isLive: boolean;
}

/** The versions kept for History, newest first, without their contents. */
export async function listRevisions(
  orm: Orm,
  input: { entry: Entry; offset: number; limit: number },
): Promise<RevisionSummary[]> {
  return orm
    .select({
      id: revisions.id,
      kind: revisions.kind,
      title: revisions.title,
      authorName: users.name,
      createdAt: revisions.createdAt,
    })
    .from(revisions)
    .leftJoin(users, eq(users.id, revisions.authorId))
    .where(eq(revisions.entryId, input.entry.id))
    .orderBy(desc(revisions.createdAt), desc(revisions.id))
    .limit(input.limit)
    .offset(input.offset)
    .all()
    .map((row) => ({ ...row, isLive: row.id === input.entry.publishedRevId }));
}

export async function getRevision(orm: Orm, id: string): Promise<Revision | undefined> {
  return orm.select().from(revisions).where(eq(revisions.id, id)).get();
}

/**
 * Brings an old version back as new changes, so nothing on the site moves until it's
 * published, and what was there is kept. The address normally stays as it is: restoring
 * words shouldn't move a page people already link to. Undoing Discard is different,
 * because that's taking back the person's own changes, including any new address.
 */
export async function restoreRevision(
  orm: Orm,
  input: {
    revision: Revision;
    expectedRev: number;
    editSession?: string | undefined;
    editSeq?: number | undefined;
    includeAddress?: boolean | undefined;
    authorId: string;
    now: number;
  },
): Promise<Entry> {
  return orm.transaction(
    (tx) => {
      const entry = requireEntry(tx, input.revision.entryId);
      requireCurrentRev(entry, input.expectedRev, input);
      if (entry.trashedAt !== null) {
        throw new ApiError(409, "in_trash", "This is in the Trash.", {
          fix: "Restore it before bringing back an older version.",
        });
      }
      keepRevision(tx, {
        entry,
        kind: "restore",
        content: entry,
        authorId: input.authorId,
        now: input.now,
      });
      const data = entryData(input.revision);
      const title = input.revision.title;
      const slug = input.includeAddress ? input.revision.slug : entry.slug;
      tx.update(entries)
        .set({
          title,
          slug,
          data,
          dirty: isDirty(tx, entry, { title, slug, data }),
          rev: entry.rev + 1,
          updatedBy: input.authorId,
          editSession: input.editSession ?? null,
          editSeq: input.editSeq ?? null,
          updatedAt: input.now,
        })
        .where(eq(entries.id, entry.id))
        .run();
      syncEntryRefs(tx, entry.id, "working", data);
      return requireEntry(tx, entry.id);
    },
    { behavior: "immediate" },
  );
}

export async function userName(orm: Orm, id: string | null): Promise<string | null> {
  if (id === null) return null;
  return orm.select({ name: users.name }).from(users).where(eq(users.id, id)).get()?.name ?? null;
}

export interface LinkTarget {
  id: string;
  type: string;
  title: string;
  /** Where visitors reach it. Null when it isn't on the site right now. */
  url: string | null;
}

/**
 * Who sees what: someone who can see everything gets the working title. A writer gets their
 * own working titles, and for anyone else's page only what's on the site. A page that's live
 * can have a working title that nobody meant to share yet.
 */
function linkTargetRows(db: Db, where: ReturnType<typeof and>, limit: number) {
  return db
    .select({ entry: entries, liveTitle: revisions.title })
    .from(entries)
    .leftJoin(revisions, eq(revisions.id, entries.publishedRevId))
    .where(where)
    .orderBy(desc(entries.updatedAt))
    .limit(limit)
    .all();
}

function toLinkTarget(
  row: { entry: Entry; liveTitle: string | null },
  authorId: string | undefined,
): LinkTarget {
  const { entry } = row;
  const seesWorkingCopy = authorId === undefined || entry.authorId === authorId;
  const onSite = entry.liveSlug !== null && entry.trashedAt === null;
  return {
    id: entry.id,
    type: entry.type,
    title: seesWorkingCopy ? entry.title : (row.liveTitle ?? ""),
    url: onSite ? entryPath({ ...entry, slug: entry.liveSlug as string }) : null,
  };
}

/** Only what's on the site is public. A writer doesn't get to see other people's drafts. */
function visibleToLinker(authorId: string | undefined) {
  return authorId === undefined
    ? undefined
    : or(isNotNull(entries.liveSlug), eq(entries.authorId, authorId));
}

/** Pages and posts to link to, for the link search. An empty query means the most recent ones. */
export async function searchLinkTargets(
  orm: Orm,
  input: { query: string; authorId: string | undefined; limit: number },
): Promise<LinkTarget[]> {
  const { authorId } = input;
  const folded = foldForSearch(input.query);
  const escaped = folded.replace(/[\\%_]/g, (character) => `\\${character}`);
  // The title this person is allowed to see: a writer gets other people's as published.
  const title =
    authorId === undefined
      ? sql`${entries.title}`
      : sql`CASE WHEN ${entries.authorId} = ${authorId} THEN ${entries.title} ELSE ${revisions.title} END`;
  const where = and(
    isNull(entries.trashedAt),
    or(gt(entries.rev, 1), isNotNull(entries.firstPublishedAt)),
    input.query ? sql`tend_fold(${title}) LIKE ${`%${escaped}%`} ESCAPE '\\'` : undefined,
    visibleToLinker(authorId),
  );
  // A title that's exactly what was typed comes first, then ones that start with it, so a
  // short title is never crowded out by longer ones that merely contain it.
  const closeness = input.query
    ? [
        sql`tend_fold(${title}) = ${folded} DESC`,
        sql`tend_fold(${title}) LIKE ${`${escaped}%`} ESCAPE '\\' DESC`,
      ]
    : [];
  return orm
    .select({ entry: entries, liveTitle: revisions.title })
    .from(entries)
    .leftJoin(revisions, eq(revisions.id, entries.publishedRevId))
    .where(where)
    .orderBy(...closeness, desc(entries.updatedAt))
    .limit(input.limit)
    .all()
    .map((row) => toLinkTarget(row, authorId));
}

/** The pages behind links already in a document. Anything missing has been deleted. */
export async function findLinkTargets(
  orm: Orm,
  input: { ids: string[]; authorId: string | undefined },
): Promise<LinkTarget[]> {
  if (input.ids.length === 0) return [];
  const where = and(inArray(entries.id, input.ids), visibleToLinker(input.authorId));
  return linkTargetRows(orm, where, input.ids.length).map((row) =>
    toLinkTarget(row, input.authorId),
  );
}

/** Whose each of these is, and its title as published (null when it isn't on the site). */
export async function findAuthorsAndLiveTitles(
  orm: Orm,
  ids: string[],
): Promise<Map<string, { authorId: string | null; liveTitle: string | null }>> {
  const found = new Map<string, { authorId: string | null; liveTitle: string | null }>();
  const wanted = [...new Set(ids)];
  for (let start = 0; start < wanted.length; start += REF_BATCH) {
    const rows = orm
      .select({ id: entries.id, authorId: entries.authorId, liveTitle: revisions.title })
      .from(entries)
      .leftJoin(revisions, eq(revisions.id, entries.publishedRevId))
      .where(inArray(entries.id, wanted.slice(start, start + REF_BATCH)))
      .all();
    for (const row of rows) found.set(row.id, { authorId: row.authorId, liveTitle: row.liveTitle });
  }
  return found;
}

/**
 * Which of these show a picture in their published version, rather than only linking to its
 * address. Moving it to the Trash takes it off the first kind, but leaves the second with a
 * link that leads nowhere.
 */
export async function findLiveShowing(
  orm: Orm,
  input: { entryIds: string[]; mediaId: string },
): Promise<Set<string>> {
  const showing = new Set<string>();
  const wanted = [...new Set(input.entryIds)];
  for (let start = 0; start < wanted.length; start += REF_BATCH) {
    const rows = orm
      .select({ id: entries.id, data: revisions.data })
      .from(entries)
      .innerJoin(revisions, eq(revisions.id, entries.publishedRevId))
      .where(inArray(entries.id, wanted.slice(start, start + REF_BATCH)))
      .all();
    for (const row of rows) {
      if (shownMediaIds(entryData(row)).includes(input.mediaId)) showing.add(row.id);
    }
  }
  return showing;
}

/**
 * Removes what's been kept long enough: the Trash, automatic versions, and rows from
 * pressing New and never typing anything. Every published version stays.
 */
export function cleanUp(orm: Orm, now: number): void {
  const cutoff = now - KEEP_DAYS * DAY_MS;
  orm.transaction(
    (tx) => {
      const expired = or(
        lt(entries.trashedAt, cutoff),
        and(eq(entries.rev, 1), isNull(entries.firstPublishedAt), lt(entries.createdAt, cutoff)),
      );
      const gone = tx.select({ id: entries.id }).from(entries).where(expired).all();
      for (const { id } of gone) {
        tx.delete(refs)
          .where(and(eq(refs.kind, "entry"), eq(refs.refId, id)))
          .run();
      }
      tx.delete(entries).where(expired).run();
      tx.delete(revisions)
        .where(and(eq(revisions.kind, "autosave"), lt(revisions.createdAt, cutoff)))
        .run();
    },
    { behavior: "immediate" },
  );
}

/** What lists need to know about something published. */
export interface LiveSummary {
  id: string;
  type: string;
  title: string;
  slug: string;
  text: string;
  /** The first paragraph's words, for an automatic summary. */
  lead: string;
  summary: string | null;
  /** The one chosen, or else the first picture in the text: "automatic". */
  featuredImage: FeaturedImage | null;
  seo: EntryData["seo"];
  firstPublishedAt: number | null;
  /** When this version was published. */
  publishedAt: number;
}

/** What visitors see: the published version, never the working copy. */
export interface LiveEntry extends LiveSummary {
  isHome: number;
  html: string;
}

const SUMMARY_FIELDS = {
  id: entries.id,
  type: entries.type,
  title: revisions.title,
  slug: revisions.slug,
  text: revisions.text,
  data: revisions.data,
  firstPublishedAt: entries.firstPublishedAt,
  publishedAt: revisions.createdAt,
};

const ENTRY_FIELDS = { ...SUMMARY_FIELDS, isHome: entries.isHome, html: revisions.html };

function toSummary(row: {
  id: string;
  type: string;
  title: string;
  slug: string;
  text: string | null;
  data: unknown;
  firstPublishedAt: number | null;
  publishedAt: number;
}): LiveSummary {
  const data = entryData(row);
  const firstImage = firstImageId(data.doc);
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    slug: row.slug,
    text: row.text ?? "",
    lead: leadText(data.doc),
    summary: data.summary,
    featuredImage: data.featuredImage ?? (firstImage ? { mediaId: firstImage, alt: null } : null),
    seo: data.seo,
    firstPublishedAt: row.firstPublishedAt,
    publishedAt: row.publishedAt,
  };
}

/** Every published page and post, for the sitemap: the newest first. */
export async function listLiveForSitemap(orm: Orm): Promise<(LiveSummary & { isHome: number })[]> {
  return orm
    .select({ ...SUMMARY_FIELDS, isHome: entries.isHome })
    .from(entries)
    .innerJoin(revisions, eq(revisions.id, entries.publishedRevId))
    .where(isLive)
    .orderBy(desc(revisions.createdAt))
    .all()
    .map((row) => ({ ...toSummary(row), isHome: row.isHome }));
}

/** Published posts by their IDs, in the order given. */
export async function findLivePosts(orm: Orm, ids: string[]): Promise<LiveSummary[]> {
  if (ids.length === 0) return [];
  const rows = orm
    .select(SUMMARY_FIELDS)
    .from(entries)
    .innerJoin(revisions, eq(revisions.id, entries.publishedRevId))
    .where(and(isLive, inArray(entries.id, ids)))
    .all()
    .map(toSummary);
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.flatMap((id) => byId.get(id) ?? []);
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

/** The addresses of whatever a page links to, in one lookup. Anything not on the site is missing. */
export async function findLivePaths(orm: Orm, ids: string[]): Promise<Map<string, string>> {
  const paths = new Map<string, string>();
  const BATCH = 500;
  for (let start = 0; start < ids.length; start += BATCH) {
    const rows = orm
      .select()
      .from(entries)
      .where(and(isLive, inArray(entries.id, ids.slice(start, start + BATCH))))
      .all();
    for (const row of rows) {
      if (row.liveSlug !== null) paths.set(row.id, entryPath({ ...row, slug: row.liveSlug }));
    }
  }
  return paths;
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

/** What a link to something live needs: its published title and address. */
export async function findLiveLinks(
  orm: Orm,
  ids: string[],
): Promise<Map<string, { title: string; path: string; type: string }>> {
  const links = new Map<string, { title: string; path: string; type: string }>();
  const wanted = [...new Set(ids)];
  for (let start = 0; start < wanted.length; start += 500) {
    const rows = orm
      .select({
        id: entries.id,
        type: entries.type,
        isHome: entries.isHome,
        liveSlug: entries.liveSlug,
        title: revisions.title,
      })
      .from(entries)
      .innerJoin(revisions, eq(revisions.id, entries.publishedRevId))
      .where(and(isLive, inArray(entries.id, wanted.slice(start, start + 500))))
      .all();
    for (const row of rows) {
      if (row.liveSlug === null) continue;
      links.set(row.id, {
        title: row.title,
        type: row.type,
        path: entryPath({ type: row.type, isHome: row.isHome, slug: row.liveSlug }),
      });
    }
  }
  return links;
}

/** Whether a published page or post is at this address now. */
export async function isLivePath(orm: Orm, path: string): Promise<boolean> {
  if (path === "/") return (await findLiveHome(orm)) !== undefined;
  const post = path.match(/^\/blog\/([^/]+)$/)?.[1];
  const page = path.match(/^\/([^/]+)$/)?.[1];
  const [type, slug] = post ? ["post", post] : page ? ["page", page] : [null, null];
  if (!type || !slug) return false;
  const row = orm
    .select({ id: entries.id })
    .from(entries)
    .where(and(isLive, eq(entries.type, type), eq(entries.liveSlug, slug)))
    .get();
  return row !== undefined;
}

/** Every published page but the homepage, for the automatic menu. */
export async function listMenuPages(
  orm: Orm,
): Promise<{ id: string; title: string; slug: string }[]> {
  return orm
    .select({ id: entries.id, title: revisions.title, slug: revisions.slug })
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
  /** Ends with a Contact & hours section, showing the business details from Settings. */
  contact?: boolean;
}

/** Creates a starting point's example content, already published. Part of setup's transaction. */
function withContactSection(doc: Doc, contact: boolean | undefined): Doc {
  if (!contact) return doc;
  return {
    type: "doc",
    content: [
      ...doc.content,
      {
        type: "section",
        attrs: { kind: "contact", preset: "1", tone: "muted", align: "left" },
        content: [
          { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Visit us" }] },
        ],
      },
    ],
  };
}

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
        data: newEntryData(withContactSection(input.toDoc(starter.body), starter.contact)),
        authorId: input.authorId,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .run();
    publishInTransaction(db, requireEntry(db, id), input);
  }
}
