import { and, desc, eq, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { ApiError } from "../api/errors.ts";
import { entryPath, slugify } from "../content/address.ts";
import { mediaIdInHref } from "../content/doc.ts";
import { settingValue } from "../content/settings.ts";
import { foldForSearch, type Orm } from "../db/client.ts";
import { entries, media, refs, users } from "../db/schema.ts";
import { uuidv7 } from "../ids.ts";
import { checkUpload, fileEnding, processFile, processImage } from "./process.ts";
import { type MediaStore, shortHash } from "./store.ts";

export type Media = typeof media.$inferSelect;

const DAY_MS = 24 * 60 * 60 * 1000;
const KEEP_DAYS = 30;
const NAME_LIMIT = 200;
const TEXT_LIMIT = 1000;

/** The widths visitors can get, smallest first. Files have none. */
export function mediaWidths(item: Pick<Media, "variants">): number[] {
  return Array.isArray(item.variants) ? (item.variants as number[]) : [];
}

export function mediaHash(item: Pick<Media, "sha256">): string {
  return shortHash(item.sha256);
}

export function variantUrl(item: Pick<Media, "id" | "sha256">, width: number): string {
  return `/media/${item.id}/${mediaHash(item)}/${width}.webp`;
}

/** The address of the file as uploaded, named so a download keeps a sensible name. */
export function originalUrl(item: Pick<Media, "id" | "sha256" | "originalName" | "ext">): string {
  return `/media/${item.id}/${mediaHash(item)}/${downloadName(item)}`;
}

/**
 * The names a picture's sizes and icons have. Its own file never takes one, or its address
 * would give the size or the icon instead.
 */
const SIZE_OR_ICON = /^(?:\d+\.webp|icon-\d+\.png)$/;

export function downloadName(item: Pick<Media, "originalName" | "ext">): string {
  const ending = fileEnding(item.originalName);
  const stem = slugify(ending ? item.originalName.slice(0, -ending.length - 1) : item.originalName);
  const name = `${stem || "file"}.${item.ext}`;
  return SIZE_OR_ICON.test(name) ? `${stem}-original.${item.ext}` : name;
}

/** What people called the file, without any folders or invisible characters. */
function visibleName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point
  const visible = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return visible || "Untitled";
}

/**
 * A name short enough to keep. Only the part before its ending is shortened, by whole
 * characters, so an emoji is never cut in half.
 */
function shortName(name: string): string {
  if ([...name].length <= NAME_LIMIT) return name;
  const ending = fileEnding(name);
  const suffix = ending ? name.slice(-ending.length - 1) : "";
  const stem = [...name.slice(0, name.length - suffix.length)];
  return `${stem
    .slice(0, NAME_LIMIT - suffix.length)
    .join("")
    .trimEnd()}${suffix}`;
}

type Upload = ReturnType<typeof checkUpload>;
type StoredVersion = Pick<
  Media,
  | "kind"
  | "mime"
  | "ext"
  | "sizeBytes"
  | "width"
  | "height"
  | "sha256"
  | "variants"
  | "dominantColor"
>;

/** The version a picture or file's row points at now, if it still has one. */
function hashInUse(orm: Orm, id: string): string | undefined {
  const row = orm.select({ sha256: media.sha256 }).from(media).where(eq(media.id, id)).get();
  return row ? shortHash(row.sha256) : undefined;
}

/**
 * Removes a version that was written for nothing. Not if the row points at it by now: the
 * same picture again makes the same files, and pages are showing them.
 */
function removeUnused(orm: Orm, store: MediaStore, id: string, hash: string, ext: string): void {
  if (hashInUse(orm, id) !== hash) store.removeVersion(id, hash, ext);
}

/**
 * Writes every file of a version, as its contents said it is. If any fails, none of them
 * stays behind, unless the version is in use already.
 */
async function storeUpload(
  orm: Orm,
  store: MediaStore,
  id: string,
  found: Upload,
  data: Buffer,
): Promise<StoredVersion> {
  if (found.kind === "file") {
    const file = processFile(data);
    const hash = shortHash(file.sha256);
    store.write(store.originalPath(id, hash, file.ext), file.original);
    return {
      kind: "file",
      mime: file.mime,
      ext: file.ext,
      sizeBytes: file.original.length,
      width: null,
      height: null,
      sha256: file.sha256,
      variants: [],
      dominantColor: null,
    };
  }
  const image = await processImage(data, found.format);
  const hash = shortHash(image.sha256);
  try {
    store.write(store.originalPath(id, hash, image.ext), image.original);
    for (const variant of image.variants) {
      store.write(store.variantPath(id, hash, `${variant.width}.webp`), variant.data);
    }
  } catch (error) {
    removeUnused(orm, store, id, hash, image.ext);
    throw error;
  }
  return {
    kind: "image",
    mime: image.mime,
    ext: image.ext,
    sizeBytes: image.original.length,
    width: image.width,
    height: image.height,
    sha256: image.sha256,
    variants: image.variants.map((variant) => variant.width),
    dominantColor: image.dominantColor,
  };
}

export async function addMedia(
  orm: Orm,
  store: MediaStore,
  input: { name: string; data: Buffer; uploadedBy: string; now: number },
): Promise<Media> {
  const id = uuidv7(input.now);
  const name = visibleName(input.name);
  // The whole name is checked, before shortening it could take its ending away.
  const stored = await storeUpload(orm, store, id, checkUpload(name, input.data), input.data);
  const originalName = shortName(name);
  try {
    return orm
      .insert(media)
      .values({
        id,
        originalName,
        ...stored,
        uploadedBy: input.uploadedBy,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .returning()
      .get();
  } catch (error) {
    store.removeVersion(id, shortHash(stored.sha256), stored.ext);
    throw error;
  }
}

export async function getMedia(orm: Orm, id: string): Promise<Media | undefined> {
  return orm.select().from(media).where(eq(media.id, id)).get();
}

/** Several at once, for pages and the editor. Missing and trashed ones are left out. */
export async function findMedia(orm: Orm, ids: string[]): Promise<Map<string, Media>> {
  const found = new Map<string, Media>();
  const wanted = [...new Set(ids)];
  for (let start = 0; start < wanted.length; start += 500) {
    const rows = orm
      .select()
      .from(media)
      .where(and(inArray(media.id, wanted.slice(start, start + 500)), isNull(media.trashedAt)))
      .all();
    for (const row of rows) found.set(row.id, row);
  }
  return found;
}

export async function listMedia(
  orm: Orm,
  input: {
    query: string;
    trashed: boolean;
    kind?: "image" | "file" | undefined;
    offset: number;
    limit: number;
  },
): Promise<Media[]> {
  const query = foldForSearch(input.query.trim());
  const pattern = `%${query.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
  return orm
    .select()
    .from(media)
    .where(
      and(
        input.trashed ? isNotNull(media.trashedAt) : isNull(media.trashedAt),
        input.kind ? eq(media.kind, input.kind) : undefined,
        query
          ? or(
              sql`tend_fold(${media.originalName}) LIKE ${pattern} ESCAPE '\\'`,
              sql`tend_fold(${media.alt}) LIKE ${pattern} ESCAPE '\\'`,
              sql`tend_fold(${media.caption}) LIKE ${pattern} ESCAPE '\\'`,
            )
          : undefined,
      ),
    )
    .orderBy(desc(media.createdAt), desc(media.id))
    .limit(input.limit)
    .offset(input.offset)
    .all();
}

export interface MediaPatch {
  alt?: string | null | undefined;
  decorative?: boolean | undefined;
  caption?: string | null | undefined;
  credit?: string | null | undefined;
}

function cleanText(value: string | null | undefined): string | null | undefined {
  if (value === undefined || value === null) return value;
  const trimmed = value.trim().slice(0, TEXT_LIMIT);
  return trimmed === "" ? null : trimmed;
}

export async function updateMedia(
  orm: Orm,
  input: { id: string; patch: MediaPatch; now: number },
): Promise<Media> {
  const { patch } = input;
  const values: Partial<Media> = { updatedAt: input.now };
  if (patch.alt !== undefined) values.alt = cleanText(patch.alt) ?? null;
  if (patch.caption !== undefined) values.caption = cleanText(patch.caption) ?? null;
  if (patch.credit !== undefined) values.credit = cleanText(patch.credit) ?? null;
  if (patch.decorative !== undefined) values.decorative = patch.decorative ? 1 : 0;
  const row = orm.update(media).set(values).where(eq(media.id, input.id)).returning().get();
  if (!row) throw gone();
  return row;
}

function gone(): ApiError {
  return new ApiError(404, "not_found", "That file is no longer here.", {
    fix: "Go back to Media.",
  });
}

/** Each picture or file's replace still running, so the next one waits its turn. */
const replacing = new Map<string, Promise<unknown>>();

/**
 * A new file in the same place: every page using it shows the new one at once. The
 * description stays, because a replacement is usually a better copy of the same thing.
 *
 * Replaces of the same one go one at a time. Two at once can each take away what the other
 * relies on: the same picture again rewrites the version the row points at, and the other
 * replace, finishing in between, removes that version as the one it replaced. The row then
 * points at files that are gone.
 */
export async function replaceMedia(
  orm: Orm,
  store: MediaStore,
  input: { id: string; name: string; data: Buffer; now: number },
): Promise<Media> {
  const earlier = replacing.get(input.id) ?? Promise.resolve();
  const replace = () => replaceInTurn(orm, store, input);
  const turn = earlier.then(replace, replace);
  replacing.set(input.id, turn);
  try {
    return await turn;
  } finally {
    if (replacing.get(input.id) === turn) replacing.delete(input.id);
  }
}

async function replaceInTurn(
  orm: Orm,
  store: MediaStore,
  input: { id: string; name: string; data: Buffer; now: number },
): Promise<Media> {
  const before = await getMedia(orm, input.id);
  if (!before) throw gone();
  const name = visibleName(input.name);
  const found = checkUpload(name, input.data);
  if ((found.kind === "file") !== (before.kind === "file")) {
    throw new ApiError(
      415,
      "different_kind",
      before.kind === "image"
        ? "A picture can only be replaced with another picture."
        : "A PDF can only be replaced with another PDF.",
      { fix: "Upload it as a new file instead." },
    );
  }
  const stored = await storeUpload(orm, store, before.id, found, input.data);
  const newHash = shortHash(stored.sha256);
  // While this one was being prepared, another replace may have changed the row, or Delete
  // forever removed it, so the version it points at now is read as it's changed.
  let changed: { row: Media; previous: Pick<Media, "sha256" | "ext"> } | undefined;
  try {
    changed = orm.transaction(
      (tx) => {
        const previous = tx
          .select({ sha256: media.sha256, ext: media.ext })
          .from(media)
          .where(eq(media.id, before.id))
          .get();
        if (!previous) return undefined;
        const row = tx
          .update(media)
          .set({ ...stored, originalName: shortName(name), updatedAt: input.now })
          .where(eq(media.id, before.id))
          .returning()
          .get();
        return row ? { row, previous } : undefined;
      },
      { behavior: "immediate" },
    );
  } catch (error) {
    removeUnused(orm, store, before.id, newHash, stored.ext);
    throw error;
  }
  if (!changed) {
    // Deleted forever meanwhile: nothing can use what was just written.
    store.removeVersion(before.id, newHash, stored.ext);
    store.removeAllSizes(before.id);
    throw gone();
  }
  // The same picture again leaves the same files, which are still in use.
  const previousHash = shortHash(changed.previous.sha256);
  if (previousHash !== newHash) store.removeVersion(before.id, previousHash, changed.previous.ext);
  return changed.row;
}

export interface MediaUse {
  id: string;
  /**
   * A post or page, or a part of the site itself: its logo, icon or picture for sharing, or
   * a link in its menu.
   */
  type: "post" | "page" | "logo" | "icon" | "share" | "menu" | (string & {});
  title: string;
  /** Where visitors see it, when a published version uses it. */
  url: string | null;
  /** The version being edited uses it. */
  inDraft: boolean;
}

/**
 * Whether a menu link leads to this file. It's read the way a link on a page is, so the
 * site menu and pages agree: with or without the site's own address in front, and with the
 * ID's letters written as %-codes too, since that reaches the same file.
 */
function leadsTo(url: string, id: string): boolean {
  return mediaIdInHref(url) === id;
}

/** Whether the main or footer menu links to this file, at the top level or under a link. */
async function menuLinksTo(orm: Orm, id: string): Promise<boolean> {
  for (const key of ["menu:main", "menu:footer"] as const) {
    const { items } = await settingValue(orm, key);
    const links = items.flatMap((item) => [item, ...(item.children ?? [])]);
    if (links.some((link) => link.target.type === "url" && leadsTo(link.target.url, id))) {
      return true;
    }
  }
  return false;
}

/**
 * Where the site itself uses a picture or file: Design's logo and icon, the picture for
 * sharing, and links in the site menu, which count once however many there are.
 */
async function siteUses(orm: Orm, id: string): Promise<MediaUse[]> {
  const design = await settingValue(orm, "design");
  const seo = await settingValue(orm, "seo");
  const uses: MediaUse[] = [];
  if (design.logoId === id)
    uses.push({ id: "logo", type: "logo", title: "", url: "/", inDraft: false });
  if (design.iconId === id)
    uses.push({ id: "icon", type: "icon", title: "", url: "/", inDraft: false });
  if (seo.imageId === id)
    uses.push({ id: "share", type: "share", title: "", url: "/", inDraft: false });
  if (await menuLinksTo(orm, id))
    uses.push({ id: "menu", type: "menu", title: "", url: "/", inDraft: false });
  return uses;
}

/** Every post and page that uses something, live or in the version being edited. */
export async function mediaUsage(orm: Orm, id: string): Promise<MediaUse[]> {
  const rows = orm
    .select({
      id: entries.id,
      type: entries.type,
      title: entries.title,
      isHome: entries.isHome,
      liveSlug: entries.liveSlug,
      scope: refs.scope,
    })
    .from(refs)
    .innerJoin(entries, eq(refs.entryId, entries.id))
    .where(and(eq(refs.kind, "media"), eq(refs.refId, id), isNull(entries.trashedAt)))
    .orderBy(entries.title, entries.id)
    .all();
  const uses = new Map<string, MediaUse>();
  for (const row of rows) {
    const use = uses.get(row.id) ?? {
      id: row.id,
      type: row.type,
      title: row.title,
      url: null,
      inDraft: false,
    };
    if (row.scope === "live" && row.liveSlug !== null) {
      use.url = entryPath({ type: row.type, isHome: row.isHome, slug: row.liveSlug });
    }
    if (row.scope === "working") use.inDraft = true;
    uses.set(row.id, use);
  }
  return [...(await siteUses(orm, id)), ...uses.values()];
}

export async function trashMedia(orm: Orm, input: { id: string; now: number }): Promise<Media> {
  const row = orm
    .update(media)
    .set({ trashedAt: input.now, updatedAt: input.now })
    .where(and(eq(media.id, input.id), isNull(media.trashedAt)))
    .returning()
    .get();
  if (row) return row;
  // Already in the Trash, from another window: that's what was wanted.
  const existing = await getMedia(orm, input.id);
  if (!existing) throw gone();
  return existing;
}

export async function restoreMedia(orm: Orm, input: { id: string; now: number }): Promise<Media> {
  const row = orm
    .update(media)
    .set({ trashedAt: null, updatedAt: input.now })
    .where(eq(media.id, input.id))
    .returning()
    .get();
  if (!row) throw gone();
  return row;
}

/** "a, b, c and 2 more": a few names, then how many others. */
function listed(names: string[]): string {
  if (names.length > 3) return `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`;
  if (names.length > 1) return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return names[0] ?? "";
}

/** "a, and b", or "a, b, and c": the steps to take, in order. */
function steps(parts: string[]): string {
  if (parts.length < 3) return parts.join(", and ");
  return `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}`;
}

interface LiveUse {
  title: string;
  /** A part of the site itself, such as "logo" or "menu", or "page" for a post or page. */
  type: string;
}

/** Where the site would lose this if it were deleted forever: its own parts, then pages. */
async function livePagesUsing(orm: Orm, id: string): Promise<LiveUse[]> {
  const names: Record<string, string> = {
    logo: "the logo",
    icon: "the site icon",
    share: "the picture for sharing",
    menu: "a link in the site menu",
  };
  const site = (await siteUses(orm, id)).map((use) => ({
    title: names[use.type] ?? use.type,
    type: use.type,
  }));
  const pages = orm
    .select({ title: entries.title })
    .from(refs)
    .innerJoin(entries, eq(refs.entryId, entries.id))
    .where(and(eq(refs.kind, "media"), eq(refs.refId, id), eq(refs.scope, "live")))
    .orderBy(entries.title)
    .all()
    .map((page) => ({ title: `"${page.title || "Untitled"}"`, type: "page" }));
  return [...site, ...pages];
}

function notInTrash(): ApiError {
  return new ApiError(409, "not_in_trash", "Only things in the Trash can be deleted forever.", {
    fix: "Move it to the Trash first.",
  });
}

/** Only from the Trash, and never while the site still uses it. */
export async function deleteMediaForever(
  orm: Orm,
  store: MediaStore,
  input: { id: string },
): Promise<void> {
  const item = await getMedia(orm, input.id);
  if (!item) return;
  if (item.trashedAt === null) throw notInTrash();
  const live = await livePagesUsing(orm, item.id);
  if (live.length > 0) {
    const site = live.filter((use) => use.type !== "page").map((use) => use.title);
    const pages = live.filter((use) => use.type === "page").map((use) => use.title);
    const where = [
      site.length > 0 ? `as ${listed(site)}` : "",
      pages.length > 0 ? `on ${listed(pages)}` : "",
    ].filter(Boolean);
    const chosen = live.some((use) => use.type !== "page" && use.type !== "menu");
    const fixes = [
      chosen ? "choose another picture in Design or Settings" : "",
      live.some((use) => use.type === "menu") ? "take the link out of the Site menu" : "",
      pages.length > 0 ? "take it out of those pages and publish them" : "",
    ].filter(Boolean);
    const fix = steps(fixes);
    throw new ApiError(409, "in_use", `Your site still uses this ${where.join(", and ")}.`, {
      fix: `${fix.charAt(0).toUpperCase()}${fix.slice(1)}, then delete it.`,
    });
  }
  // A replace may have finished while the uses were looked up, so the version removed is
  // the one the row has as it goes.
  const removed = orm.transaction(
    (tx) => {
      const row = tx
        .delete(media)
        .where(and(eq(media.id, item.id), isNotNull(media.trashedAt)))
        .returning({ sha256: media.sha256, ext: media.ext })
        .get();
      if (row) {
        tx.delete(refs)
          .where(and(eq(refs.kind, "media"), eq(refs.refId, item.id)))
          .run();
      }
      return row;
    },
    { behavior: "immediate" },
  );
  if (!removed) {
    // Brought back from the Trash meanwhile, it stays. Deleted from another window, it's gone.
    if (await getMedia(orm, item.id)) throw notInTrash();
    return;
  }
  store.removeVersion(item.id, shortHash(removed.sha256), removed.ext);
  store.removeAllSizes(item.id);
}

/** Long after any write that started then could still be going. */
const LEFTOVER_AGE_MS = 60 * 60 * 1000;

/**
 * Empties the Trash after 30 days, except what a published page still uses, and removes
 * files a crash left half written.
 */
export async function cleanUpMedia(orm: Orm, store: MediaStore, now: number): Promise<void> {
  store.removeLeftovers(now - LEFTOVER_AGE_MS);
  const expired = orm
    .select({ id: media.id })
    .from(media)
    .where(lt(media.trashedAt, now - KEEP_DAYS * DAY_MS))
    .all();
  for (const { id } of expired) {
    if ((await livePagesUsing(orm, id)).length > 0) continue;
    // Brought back, or put to use, while this ran: it's looked at again next time.
    await deleteMediaForever(orm, store, { id }).catch((error: unknown) => {
      if (!(error instanceof ApiError)) throw error;
    });
  }
}

export async function uploaderName(orm: Orm, id: string | null): Promise<string | null> {
  if (!id) return null;
  return orm.select({ name: users.name }).from(users).where(eq(users.id, id)).get()?.name ?? null;
}
