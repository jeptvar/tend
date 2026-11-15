import type { Context } from "hono";
import { z } from "zod";
import { type Action, can, seesOnlyOwnEntries } from "../../auth/policy.ts";
import { entryPath } from "../../content/address.ts";
import {
  DocProblem,
  docField,
  type EntryData,
  isMediaId,
  parseDoc,
  parseFeaturedImage,
} from "../../content/doc.ts";
import {
  checkAddress,
  createEntry,
  deleteEntryForever,
  discardChanges,
  duplicateEntry,
  type Entry,
  type EntryType,
  findLinkTargets,
  getEntry,
  getRevision,
  listEntries,
  listRevisions,
  publishEntry,
  type Revision,
  restoreEntry,
  restoreRevision,
  saveEntry,
  searchLinkTargets,
  trashEntry,
  undoUnpublish,
  unpublishEntry,
  userName,
} from "../../content/entries.ts";
import { writeSetting } from "../../content/settings.ts";
import { existingTagIds } from "../../content/tags.ts";
import type { User } from "../../db/repo/users.ts";
import { uuidv7 } from "../../ids.ts";
import { menuLinksTo, menuSetting } from "../../site/menus.ts";
import type { PreviewInput } from "../../site/router.ts";
import { ApiError } from "../errors.ts";
import { type AdminOptions, offsetFrom, parseBody, type Routing, readJson } from "./routing.ts";

const PAGE_SIZE = 100;
/** The most links a menu takes at its top level (content/settings.ts, menuSchema). */
const MENU_LIMIT = 30;
const LINK_TARGET_LIMIT = 8;
const LINK_LOOKUP_LIMIT = 200;
const REVISION_PAGE_SIZE = 100;

const typeSchema = z.enum(["post", "page"], { error: "That isn't a kind of content Tend knows." });

const createSchema = z.object({ type: typeSchema });

const patchSchema = z.object({
  title: z.string().max(200, "Use 200 characters or fewer for the title.").optional(),
  slug: z.string().max(200, "That page address is too long.").optional(),
  doc: docField.optional(),
  summary: z
    .string()
    .max(300, "Use 300 characters or fewer for the summary.")
    .nullable()
    .optional(),
  featuredImage: z.unknown().optional(),
  seo: z
    .object({
      title: z
        .string()
        .max(200, "Use 200 characters or fewer for the search title.")
        .nullable()
        .optional(),
      description: z
        .string()
        .max(400, "Use 400 characters or fewer for the search description.")
        .nullable()
        .optional(),
      imageId: z.string().max(64).nullable().optional(),
      noindex: z.boolean().optional(),
    })
    .optional(),
  tagIds: z.array(z.string().max(64)).max(50, "Use 50 tags or fewer.").optional(),
  keepOtherVersion: z.boolean().optional(),
  editSession: z.string().max(64).optional(),
  editSeq: z.number().int().nonnegative().optional(),
});

const actionSchema = z.object({
  /** Which editor window this came from. It may not have heard about its own last change. */
  editSession: z.string().max(64).optional(),
  editSeq: z.number().int().nonnegative().optional(),
  /** Taking back a discard, which brings back a changed address as well. */
  includeAddress: z.boolean().optional(),
  revisionId: z.string().max(64).optional(),
  /** "Show in site menu", ticked when publishing. */
  addToMenu: z.boolean().optional(),
});

/** What an action might say about itself. Nothing here is required. */
async function actionBody(c: Context): Promise<z.infer<typeof actionSchema>> {
  const parsed = actionSchema.safeParse(await readJson(c));
  return parsed.success ? parsed.data : {};
}

function expectedRev(c: Context): number {
  const header = c.req.header("if-match");
  const rev = Number(header);
  if (!header || !Number.isInteger(rev) || rev < 1) {
    throw new ApiError(400, "needs_fixing", "Tend needs to know which version you were editing.");
  }
  return rev;
}

function summaryJson(entry: Entry) {
  return {
    id: entry.id,
    type: entry.type,
    status: entry.status,
    title: entry.title,
    slug: entry.slug,
    isHome: entry.isHome === 1,
    isExample: entry.isExample === 1,
    dirty: entry.dirty === 1,
    rev: entry.rev,
    /** Where visitors can see it right now, if they can. */
    url: entry.liveSlug === null ? null : entryPath({ ...entry, slug: entry.liveSlug }),
    firstPublishedAt: entry.firstPublishedAt,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    trashedAt: entry.trashedAt,
  };
}

/** Blank means "fill in automatically", so it's stored as null. */
function cleanSeo(seo: {
  title?: string | null | undefined;
  description?: string | null | undefined;
  imageId?: string | null | undefined;
  noindex?: boolean | undefined;
}): Partial<EntryData["seo"]> {
  const blankIsNull = (value: string | null | undefined) =>
    value === undefined ? undefined : value === null || value.trim() === "" ? null : value.trim();
  const cleaned: Partial<EntryData["seo"]> = {};
  const title = blankIsNull(seo.title);
  const description = blankIsNull(seo.description);
  if (title !== undefined) cleaned.title = title;
  if (description !== undefined) cleaned.description = description;
  if (seo.imageId !== undefined) cleaned.imageId = isMediaId(seo.imageId) ? seo.imageId : null;
  if (seo.noindex !== undefined) cleaned.noindex = seo.noindex;
  return cleaned;
}

function checkedDoc(value: unknown, type: string) {
  try {
    return parseDoc(value, { allowSections: type === "page" });
  } catch (error) {
    if (!(error instanceof DocProblem)) throw error;
    throw new ApiError(400, "needs_fixing", "Tend couldn't save that content.", {
      field: "doc",
      fix: "Undo your last change, then try again.",
    });
  }
}

/** The routes for posts, pages and their history. */
export function registerEntryRoutes(routing: Routing, options: AdminOptions): void {
  const { orm } = options;
  const { now, refuse, route } = routing;

  /** Whether the site menu links to this, for "Show in site menu" when publishing. */
  async function menuJson(entry: Entry) {
    const { menu, automatic } = await menuSetting(orm, "main");
    return {
      // An automatic menu has every published page already.
      automatic,
      inMenu: automatic ? entry.type === "page" && entry.isHome === 0 : menuLinksTo(menu, entry.id),
      size: menu.items.length,
    };
  }

  /** Adds a link at the end of the main menu, unless one's already there. */
  async function addToMainMenu(entry: Entry, userId: string) {
    const { menu, automatic } = await menuSetting(orm, "main");
    // A full menu stays as it is: the Site menu screen is where room can be made.
    if (automatic || menuLinksTo(menu, entry.id) || menu.items.length >= MENU_LIMIT) return;
    await writeSetting(orm, {
      key: "menu:main",
      value: {
        items: [
          ...menu.items,
          { id: uuidv7(now()), label: null, target: { type: "entry", id: entry.id }, children: [] },
        ],
      },
      userId,
      now: now(),
    });
  }

  /** Everything the editor needs to know, including problems it can warn about early. */
  async function entryJson(entry: Entry) {
    const { path, problem } = await checkAddress(orm, entry);
    return {
      ...summaryJson(entry),
      data: entry.data,
      menu: await menuJson(entry),
      updatedBy: entry.updatedBy
        ? { id: entry.updatedBy, name: await userName(orm, entry.updatedBy) }
        : null,
      /** What the address would be if this were published now. */
      address: {
        path,
        problem: problem ? { message: problem.message, fix: problem.details.fix ?? null } : null,
      },
    };
  }

  /** Whose it is, and whether it's a page, which a Writer can't touch even when it's theirs. */
  function subjectOf(entry: Entry) {
    return { authorId: entry.authorId, type: entry.type };
  }

  /** A route about one entry, checked against that entry. */
  function entryRoute(
    method: "get" | "post" | "patch" | "delete",
    path: string,
    action: Action,
    handler: (c: Context, user: User, entry: Entry) => Promise<Response>,
  ): void {
    routing.subjectRoute(
      method,
      path,
      action,
      {
        kind: "entry",
        load: (c) => getEntry(orm, c.req.param("id") as string),
        missing: () =>
          new ApiError(404, "not_found", "That's no longer here.", { fix: "Go back to the list." }),
        owner: subjectOf,
      },
      handler,
    );
  }

  /** A route about one saved version, checked against the entry it belongs to. */
  function revisionRoute(
    method: "get" | "post",
    path: string,
    action: Action,
    handler: (c: Context, user: User, entry: Entry, revision: Revision) => Promise<Response>,
  ): void {
    routing.subjectRoute(
      method,
      path,
      action,
      {
        kind: "revision",
        load: async (c) => {
          const revision = await getRevision(orm, c.req.param("rid") as string);
          const entry = revision && (await getEntry(orm, revision.entryId));
          return revision && entry ? { revision, entry } : undefined;
        },
        missing: () =>
          new ApiError(404, "not_found", "That version is no longer here.", {
            fix: "Go back to History.",
          }),
        owner: ({ entry }) => subjectOf(entry),
      },
      (c, user, { entry, revision }) => handler(c, user, entry, revision),
    );
  }

  function requirePreview() {
    if (!options.preview) throw new Error("Previews aren't available here.");
    return options.preview;
  }

  route("get", "/link-targets", "entry:list", async (c, user) => {
    const authorId = seesOnlyOwnEntries(user) ? user.id : undefined;
    const ids = c.req.query("ids");
    if (ids !== undefined) {
      const wanted = ids.split(",").filter(Boolean).slice(0, LINK_LOOKUP_LIMIT);
      return c.json({ targets: await findLinkTargets(orm, { ids: wanted, authorId }) });
    }
    const query = (c.req.query("q") ?? "").trim().slice(0, 200);
    return c.json({
      targets: await searchLinkTargets(orm, { query, authorId, limit: LINK_TARGET_LIMIT }),
    });
  });

  route("get", "/entries", "entry:list", async (c, user) => {
    const type = parseBody(typeSchema, c.req.query("type")) as EntryType;
    const offset = offsetFrom(c);
    const rows = await listEntries(orm, {
      type,
      trashed: c.req.query("view") === "trash",
      authorId: seesOnlyOwnEntries(user) ? user.id : undefined,
      offset,
      limit: PAGE_SIZE + 1,
    });
    return c.json({
      entries: rows.slice(0, PAGE_SIZE).map(summaryJson),
      nextCursor: rows.length > PAGE_SIZE ? String(offset + PAGE_SIZE) : null,
    });
  });

  route("post", "/entries", "entry:create", async (c, user) => {
    const { type } = parseBody(createSchema, await readJson(c));
    // A Writer's account is for posts: pages are how the site is laid out (PLAN.md §6).
    if (!can(user, "entry:create", { authorId: user.id, type })) {
      throw new ApiError(403, "not_allowed", "Your account can write posts, but not pages.", {
        fix: "Ask whoever runs this site to add the page.",
      });
    }
    const entry = await createEntry(orm, { type, authorId: user.id, now: now() });
    return c.json(await entryJson(entry), 201);
  });

  entryRoute("get", "/entries/:id", "entry:read", async (c, _user, entry) =>
    c.json(await entryJson(entry)),
  );

  entryRoute("patch", "/entries/:id", "entry:update", async (c, user, entry) => {
    const { doc, featuredImage, seo, tagIds, ...fields } = parseBody(
      patchSchema,
      await readJson(c),
    );
    const result = await saveEntry(orm, {
      id: entry.id,
      expectedRev: expectedRev(c),
      patch: {
        ...fields,
        doc: doc === undefined ? undefined : checkedDoc(doc, entry.type),
        featuredImage: featuredImage === undefined ? undefined : parseFeaturedImage(featuredImage),
        seo: seo === undefined ? undefined : cleanSeo(seo),
        // Only posts have tags. A tag's page lists posts, so one on a page would lead nowhere.
        tagIds:
          tagIds === undefined || entry.type !== "post"
            ? undefined
            : await existingTagIds(orm, tagIds),
      },
      authorId: user.id,
      now: now(),
    });
    if ("conflict" in result) {
      const error = new ApiError(
        409,
        "edit_conflict",
        "This changed somewhere else while you had it open.",
        { fix: "Your version has been kept. Choose which one to carry on with." },
      );
      return c.json({ ...error.toJSON(), current: await entryJson(result.conflict) }, 409);
    }
    return c.json(await entryJson(result.saved));
  });

  entryRoute("post", "/entries/:id/publish", "entry:publish", async (c, user, entry) => {
    const { editSession, editSeq, addToMenu } = await actionBody(c);
    const published = await publishEntry(orm, {
      id: entry.id,
      expectedRev: expectedRev(c),
      editSession,
      editSeq,
      authorId: user.id,
      now: now(),
    });
    if (addToMenu && can(user, "menu:manage")) await addToMainMenu(published, user.id);
    options.onSiteChanged(summaryJson(published).url ?? undefined);
    return c.json(await entryJson(published));
  });

  entryRoute("post", "/entries/:id/unpublish", "entry:publish", async (c, user, entry) => {
    const { editSession, editSeq } = await actionBody(c);
    const result = await unpublishEntry(orm, {
      id: entry.id,
      expectedRev: expectedRev(c),
      editSession,
      editSeq,
      authorId: user.id,
      now: now(),
    });
    options.onSiteChanged();
    return c.json({
      ...(await entryJson(result.entry)),
      wasLiveRevisionId: result.wasLiveRevisionId,
    });
  });

  entryRoute("post", "/entries/:id/undo-unpublish", "entry:publish", async (c, user, entry) => {
    const { editSession, editSeq, revisionId } = await actionBody(c);
    const restored = await undoUnpublish(orm, {
      id: entry.id,
      revisionId: revisionId ?? "",
      expectedRev: expectedRev(c),
      editSession,
      editSeq,
      authorId: user.id,
      now: now(),
    });
    options.onSiteChanged(summaryJson(restored).url ?? undefined);
    return c.json(await entryJson(restored));
  });

  entryRoute("post", "/entries/:id/trash", "entry:trash", async (c, user, entry) => {
    const trashed = await trashEntry(orm, { id: entry.id, authorId: user.id, now: now() });
    options.onSiteChanged();
    return c.json(await entryJson(trashed));
  });

  entryRoute("post", "/entries/:id/restore", "entry:trash", async (c, user, entry) => {
    const restored = await restoreEntry(orm, { id: entry.id, authorId: user.id, now: now() });
    return c.json(await entryJson(restored));
  });

  entryRoute("post", "/entries/:id/discard-changes", "entry:publish", async (c, user, entry) => {
    const { editSession, editSeq } = await actionBody(c);
    const result = await discardChanges(orm, {
      id: entry.id,
      expectedRev: expectedRev(c),
      editSession,
      editSeq,
      authorId: user.id,
      now: now(),
    });
    return c.json({
      ...(await entryJson(result.entry)),
      keptRevisionId: result.keptRevisionId,
    });
  });

  entryRoute("post", "/entries/:id/duplicate", "entry:read", async (c, user, entry) => {
    if (!can(user, "entry:create", { authorId: user.id, type: entry.type })) throw refuse();
    return c.json(
      await entryJson(await duplicateEntry(orm, { id: entry.id, authorId: user.id, now: now() })),
      201,
    );
  });

  entryRoute("delete", "/entries/:id", "entry:delete", async (c, _user, entry) => {
    await deleteEntryForever(orm, { id: entry.id });
    return c.body(null, 204);
  });

  entryRoute("get", "/entries/:id/revisions", "entry:read", async (c, _user, entry) => {
    const offset = offsetFrom(c);
    const rows = await listRevisions(orm, { entry, offset, limit: REVISION_PAGE_SIZE + 1 });
    return c.json({
      revisions: rows.slice(0, REVISION_PAGE_SIZE),
      nextCursor: rows.length > REVISION_PAGE_SIZE ? String(offset + REVISION_PAGE_SIZE) : null,
    });
  });

  revisionRoute("get", "/revisions/:rid", "entry:read", async (c, _user, entry, revision) => {
    return c.json({
      id: revision.id,
      kind: revision.kind,
      title: revision.title,
      slug: revision.slug,
      createdAt: revision.createdAt,
      data: revision.data,
      // JSON rather than a page of its own, so this can only be shown in the sandboxed frame.
      previewHtml: await requirePreview()({
        type: entry.type,
        isHome: entry.isHome,
        title: revision.title,
        slug: entry.slug,
        data: revision.data as PreviewInput["data"],
        firstPublishedAt: entry.firstPublishedAt,
        now: now(),
      }),
    });
  });

  revisionRoute(
    "post",
    "/revisions/:rid/restore",
    "entry:update",
    async (c, user, _e, revision) => {
      const { editSession, editSeq, includeAddress } = await actionBody(c);
      const restored = await restoreRevision(orm, {
        revision,
        expectedRev: expectedRev(c),
        editSession,
        editSeq,
        includeAddress,
        authorId: user.id,
        now: now(),
      });
      return c.json(await entryJson(restored));
    },
  );

  entryRoute("get", "/preview/:id", "entry:read", async (c, _user, entry) => {
    c.header("Cache-Control", "no-store");
    return c.json({
      // JSON rather than a page of its own, so this can only be shown in the sandboxed frame.
      html: await requirePreview()({
        type: entry.type,
        isHome: entry.isHome,
        title: entry.title,
        slug: entry.slug,
        data: entry.data as PreviewInput["data"],
        firstPublishedAt: entry.firstPublishedAt,
        now: now(),
      }),
    });
  });
}
