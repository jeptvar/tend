import { inArray } from "drizzle-orm";
import type { Context } from "hono";
import { z } from "zod";
import { type Action, can, seesOnlyOwnEntries } from "../../auth/policy.ts";
import { isMediaId } from "../../content/doc.ts";
import { findAuthorsAndLiveTitles, findLiveShowing } from "../../content/entries.ts";
import type { User } from "../../db/repo/users.ts";
import { media as mediaTable, users } from "../../db/schema.ts";
import {
  addMedia,
  deleteMediaForever,
  getMedia,
  listMedia,
  type Media,
  type MediaUse,
  mediaUsage,
  mediaWidths,
  originalUrl,
  replaceMedia,
  restoreMedia,
  trashMedia,
  updateMedia,
  variantUrl,
} from "../../media/library.ts";
import { ApiError } from "../errors.ts";
import {
  type AdminOptions,
  offsetFrom,
  parseBody,
  type Routing,
  readJson,
  type SubjectLoader,
} from "./routing.ts";

const PAGE_SIZE = 60;
/** How many are looked up in one statement, which can only carry so many values. */
const LOOKUP_BATCH = 500;
/** The size the admin shows a picture at, when it has one this big. */
const PREVIEW_WIDTH = 960;

const patchSchema = z.object({
  alt: z.string().max(1000, "Use 1,000 characters or fewer.").nullable().optional(),
  decorative: z.boolean().optional(),
  caption: z.string().max(1000, "Use 1,000 characters or fewer.").nullable().optional(),
  credit: z.string().max(1000, "Use 1,000 characters or fewer.").nullable().optional(),
});

/**
 * The parts of the site itself that can use a picture or file, and who may change each one:
 * whoever can choose it there. Replacing or trashing it changes every page at once, so an
 * Editor can't do through Media what Design or Settings wouldn't let them (PLAN.md §6).
 */
const SITE_USES: Record<string, { action: Action; message: string; fix: string }> = {
  logo: {
    action: "design:manage",
    message: "This is your site's logo, which your account can't change.",
    fix: "Ask whoever runs this site to choose another logo first.",
  },
  icon: {
    action: "design:manage",
    message: "This is your site icon, which your account can't change.",
    fix: "Ask whoever runs this site to choose another site icon first.",
  },
  share: {
    action: "settings:manage",
    message: "This is your site's picture for sharing, which your account can't change.",
    fix: "Ask whoever runs this site to choose another picture for sharing first.",
  },
  menu: {
    action: "menu:manage",
    message: "Your site menu links to this, and your account can't change the menu.",
    fix: "Ask whoever runs this site to take it out of the site menu first.",
  },
};

/** A post or page, rather than a part of the site itself. */
function isEntryUse(use: MediaUse): boolean {
  return use.type === "post" || use.type === "page";
}

/** The file's own name, sent beside it because the body is the file itself. */
function uploadName(c: Context): string {
  const header = c.req.header("x-file-name") ?? "";
  try {
    return decodeURIComponent(header);
  } catch {
    return header;
  }
}

async function uploadBody(c: Context): Promise<Buffer> {
  const data = Buffer.from(await c.req.arrayBuffer());
  if (data.length === 0) {
    throw new ApiError(400, "empty_file", "That file is empty.", {
      fix: "Check it opens on your computer, then try again.",
    });
  }
  return data;
}

/** The routes for Media: uploads, the library, descriptions and the Trash. */
export function registerMediaRoutes(routing: Routing, options: AdminOptions): void {
  const { orm, store } = options;
  const { now, route } = routing;

  const subject: SubjectLoader<Media> = {
    kind: "media",
    load: async (c) => {
      const id = c.req.param("mid");
      return isMediaId(id) ? getMedia(orm, id) : undefined;
    },
    missing: () =>
      new ApiError(404, "not_found", "That file is no longer here.", { fix: "Go back to Media." }),
    owner: (item) => ({ authorId: item.uploadedBy }),
  };

  async function uploaderNames(items: Media[]): Promise<Map<string, string>> {
    const ids = [...new Set(items.flatMap((item) => (item.uploadedBy ? [item.uploadedBy] : [])))];
    if (ids.length === 0) return new Map();
    const rows = orm
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(inArray(users.id, ids))
      .all();
    return new Map(rows.map((row) => [row.id, row.name]));
  }

  function mediaJson(item: Media, names: Map<string, string>) {
    const widths = mediaWidths(item);
    const preview = widths.filter((width) => width <= PREVIEW_WIDTH).pop() ?? widths[0];
    return {
      id: item.id,
      kind: item.kind,
      name: item.originalName,
      mime: item.mime,
      sizeBytes: item.sizeBytes,
      width: item.width,
      height: item.height,
      alt: item.alt,
      decorative: item.decorative === 1,
      caption: item.caption,
      credit: item.credit,
      dominantColor: item.dominantColor,
      url: originalUrl(item),
      thumbUrl: widths[0] === undefined ? null : variantUrl(item, widths[0]),
      previewUrl: preview === undefined ? null : variantUrl(item, preview),
      srcset: widths.map((width) => `${variantUrl(item, width)} ${width}w`).join(", "),
      uploadedBy: item.uploadedBy
        ? { id: item.uploadedBy, name: names.get(item.uploadedBy) ?? null }
        : null,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      trashedAt: item.trashedAt,
    };
  }

  async function oneJson(item: Media) {
    return mediaJson(item, await uploaderNames([item]));
  }

  function itemRoute(
    method: "get" | "post" | "patch" | "delete",
    path: string,
    action: Action,
    handler: (c: Context, user: User, item: Media) => Promise<Response>,
  ): void {
    routing.subjectRoute(method, path, action, subject, handler);
  }

  /** These, in the Trash or not, a batch at a time. */
  function lookUp(ids: string[]): Media[] {
    const found: Media[] = [];
    for (let start = 0; start < ids.length; start += LOOKUP_BATCH) {
      const batch = ids.slice(start, start + LOOKUP_BATCH);
      found.push(...orm.select().from(mediaTable).where(inArray(mediaTable.id, batch)).all());
    }
    return found;
  }

  /**
   * Where something is used, as this person may see it. A Writer sees their own posts as they
   * are, and anyone else's only where it's on the site, by its published title: other people's
   * drafts aren't theirs to read, the same as in the link search.
   */
  async function visibleUses(user: User, uses: MediaUse[]): Promise<MediaUse[]> {
    if (!seesOnlyOwnEntries(user)) return uses;
    const entries = await findAuthorsAndLiveTitles(
      orm,
      uses.filter(isEntryUse).map((use) => use.id),
    );
    return uses.flatMap((use) => {
      if (!isEntryUse(use)) return [use];
      const entry = entries.get(use.id);
      if (entry?.authorId === user.id) return [use];
      if (use.url === null || !entry?.liveTitle) return [];
      return [{ ...use, title: entry.liveTitle, inDraft: false }];
    });
  }

  /** Something the whole site uses can only be swapped or removed by whoever chose it there. */
  function refuseSiteUses(user: User, uses: MediaUse[]): void {
    for (const use of uses) {
      const rule = SITE_USES[use.type];
      if (rule && !can(user, rule.action)) {
        throw new ApiError(403, "used_by_site", rule.message, { fix: rule.fix });
      }
    }
  }

  /**
   * Someone who can't publish has their words looked over before visitors see them. A
   * picture's description, caption and credit change every page showing it as soon as they're
   * saved, so once the site uses it, changing them is for someone who can publish.
   */
  async function refuseUnreviewed(user: User, item: Media): Promise<void> {
    if (can(user, "entry:publish")) return;
    if ((await mediaUsage(orm, item.id)).some((use) => use.url !== null)) {
      throw new ApiError(
        403,
        "on_your_site",
        "This is on your site already, so changing it needs someone who can publish.",
        { fix: "Ask an editor, or whoever runs this site, to change it." },
      );
    }
  }

  /**
   * Marks the pages that only link to it, rather than show it. Moving it to the Trash takes
   * a picture off a page, but a link stays where it is, and leads nowhere until it's back.
   */
  async function markLinkOnly(id: string, uses: MediaUse[]) {
    const live = uses.filter((use) => isEntryUse(use) && use.url !== null);
    const showing = await findLiveShowing(orm, {
      entryIds: live.map((use) => use.id),
      mediaId: id,
    });
    return uses.map((use) =>
      live.includes(use) && !showing.has(use.id) ? { ...use, linkOnly: true } : use,
    );
  }

  route("get", "/media", "media:list", async (c) => {
    // The editor asking about the pictures in one document, including any in the Trash.
    const ids = c.req.query("ids");
    if (ids !== undefined) {
      // Every one asked about is answered. One left out would look as if it had been deleted.
      const rows = lookUp([...new Set(ids.split(",").filter(isMediaId))]);
      const names = await uploaderNames(rows);
      return c.json({ media: rows.map((row) => mediaJson(row, names)), nextCursor: null });
    }
    const offset = offsetFrom(c);
    const kind = c.req.query("kind");
    const rows = await listMedia(orm, {
      query: (c.req.query("q") ?? "").slice(0, 200),
      trashed: c.req.query("view") === "trash",
      kind: kind === "image" || kind === "file" ? kind : undefined,
      offset,
      limit: PAGE_SIZE + 1,
    });
    const page = rows.slice(0, PAGE_SIZE);
    const names = await uploaderNames(page);
    return c.json({
      media: page.map((row) => mediaJson(row, names)),
      nextCursor: rows.length > PAGE_SIZE ? String(offset + PAGE_SIZE) : null,
    });
  });

  route("post", "/media", "media:upload", async (c, user) => {
    const item = await addMedia(orm, store, {
      name: uploadName(c),
      data: await uploadBody(c),
      uploadedBy: user.id,
      now: now(),
    });
    return c.json(await oneJson(item), 201);
  });

  itemRoute("get", "/media/:mid", "media:list", async (c, _user, item) =>
    c.json(await oneJson(item)),
  );

  itemRoute("patch", "/media/:mid", "media:update", async (c, user, item) => {
    await refuseUnreviewed(user, item);
    const patch = parseBody(patchSchema, await readJson(c));
    const updated = await updateMedia(orm, { id: item.id, patch, now: now() });
    options.onSiteChanged();
    return c.json(await oneJson(updated));
  });

  itemRoute("get", "/media/:mid/usage", "media:list", async (c, user, item) =>
    c.json({ uses: await visibleUses(user, await mediaUsage(orm, item.id)) }),
  );

  itemRoute("post", "/media/:mid/replace", "media:replace", async (c, user, item) => {
    // Before the file is read: it may be 20 MB that would only be thrown away.
    refuseSiteUses(user, await mediaUsage(orm, item.id));
    const replaced = await replaceMedia(orm, store, {
      id: item.id,
      name: uploadName(c),
      data: await uploadBody(c),
      now: now(),
    });
    options.onSiteChanged();
    return c.json(await oneJson(replaced));
  });

  itemRoute("post", "/media/:mid/trash", "media:trash", async (c, user, item) => {
    const uses = await mediaUsage(orm, item.id);
    refuseSiteUses(user, uses);
    const trashed = await trashMedia(orm, { id: item.id, now: now() });
    options.onSiteChanged();
    return c.json({ ...(await oneJson(trashed)), uses: await markLinkOnly(item.id, uses) });
  });

  itemRoute("post", "/media/:mid/restore", "media:trash", async (c, _user, item) => {
    const restored = await restoreMedia(orm, { id: item.id, now: now() });
    options.onSiteChanged();
    return c.json(await oneJson(restored));
  });

  itemRoute("delete", "/media/:mid", "media:delete", async (c, _user, item) => {
    await deleteMediaForever(orm, store, { id: item.id });
    return c.body(null, 204);
  });
}
