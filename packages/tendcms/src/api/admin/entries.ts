import { type Context, Hono } from "hono";
import { z } from "zod";
import { currentUser } from "../../auth/current-user.ts";
import { type Action, can, seesOnlyOwnEntries } from "../../auth/policy.ts";
import { entryPath } from "../../content/address.ts";
import { docSchema } from "../../content/doc.ts";
import {
  createEntry,
  type Entry,
  type EntryType,
  getEntry,
  listEntries,
  publishEntry,
  restoreEntry,
  saveEntry,
  trashEntry,
  unpublishEntry,
} from "../../content/entries.ts";
import type { Orm } from "../../db/client.ts";
import type { User } from "../../db/repo/users.ts";
import { ApiError } from "../errors.ts";

export interface AdminOptions {
  orm: Orm;
  secureCookies: boolean;
  now?: (() => number) | undefined;
  /** Called after anything that changes what visitors see. */
  onSiteChanged: (changedPath?: string) => void;
}

export interface RoutePolicy {
  method: string;
  path: string;
  action: Action;
  /** The route loads an entry and checks the action against it. */
  hasSubject: boolean;
}

const PAGE_SIZE = 100;

const typeSchema = z.enum(["post", "page"], { error: "That isn't a kind of content Tend knows." });

const createSchema = z.object({ type: typeSchema });

const patchSchema = z.object({
  title: z.string().max(200, "Use 200 characters or fewer for the title.").optional(),
  slug: z.string().max(200, "That page address is too long.").optional(),
  doc: docSchema.optional(),
  summary: z
    .string()
    .max(300, "Use 300 characters or fewer for the summary.")
    .nullable()
    .optional(),
  keepOtherVersion: z.boolean().optional(),
});

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const field = issue?.path[0];
  // A document that fails the allowlist isn't something a person typed wrong.
  const message =
    field === "doc"
      ? "Tend couldn't save that content."
      : (issue?.message ?? "Check what you typed.");
  throw new ApiError(400, "needs_fixing", message, {
    ...(typeof field === "string" ? { field } : {}),
  });
}

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new ApiError(400, "unreadable_request", "Tend couldn't read that request. Try again.");
  }
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

function entryJson(entry: Entry) {
  return { ...summaryJson(entry), data: entry.data };
}

/** Everything under /api/admin. Each route has to state the action that guards it. */
export function createAdminRoutes(options: AdminOptions): { app: Hono; policies: RoutePolicy[] } {
  const { orm } = options;
  const now = options.now ?? Date.now;
  const app = new Hono();
  const policies: RoutePolicy[] = [];

  async function requireUser(c: Context): Promise<User> {
    const user = await currentUser(c, orm, options.secureCookies, now());
    if (!user) {
      throw new ApiError(401, "not_signed_in", "You're not signed in.", {
        fix: "Sign in again. What you've typed stays in this tab.",
      });
    }
    return user;
  }

  function refuse(): ApiError {
    return new ApiError(403, "not_allowed", "Your account can't do that.", {
      fix: "Ask whoever runs this site.",
    });
  }

  /** A route with no particular entry involved. */
  function route(
    method: "get" | "post",
    path: string,
    action: Action,
    handler: (c: Context, user: User) => Promise<Response>,
  ): void {
    policies.push({ method: method.toUpperCase(), path, action, hasSubject: false });
    app[method](path, async (c) => {
      const user = await requireUser(c);
      if (!can(user, action)) throw refuse();
      return handler(c, user);
    });
  }

  /** A route about one entry, checked against that entry. */
  function entryRoute(
    method: "get" | "post" | "patch",
    path: string,
    action: Action,
    handler: (c: Context, user: User, entry: Entry) => Promise<Response>,
  ): void {
    policies.push({ method: method.toUpperCase(), path, action, hasSubject: true });
    app[method](path, async (c) => {
      const user = await requireUser(c);
      const entry = await getEntry(orm, c.req.param("id") as string);
      if (!entry) {
        throw new ApiError(404, "not_found", "That's no longer here.", {
          fix: "Go back to the list.",
        });
      }
      if (!can(user, action, entry)) throw refuse();
      return handler(c, user, entry);
    });
  }

  route("get", "/entries", "entry:list", async (c, user) => {
    const type = parseBody(typeSchema, c.req.query("type")) as EntryType;
    const parsed = Number.parseInt(c.req.query("cursor") ?? "0", 10);
    const offset = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
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
    const entry = await createEntry(orm, { type, authorId: user.id, now: now() });
    return c.json(entryJson(entry), 201);
  });

  entryRoute("get", "/entries/:id", "entry:read", async (c, _user, entry) =>
    c.json(entryJson(entry)),
  );

  entryRoute("patch", "/entries/:id", "entry:update", async (c, user, entry) => {
    const patch = parseBody(patchSchema, await readJson(c));
    const result = await saveEntry(orm, {
      id: entry.id,
      expectedRev: expectedRev(c),
      patch,
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
      return c.json({ ...error.toJSON(), current: entryJson(result.conflict) }, 409);
    }
    return c.json(entryJson(result.saved));
  });

  entryRoute("post", "/entries/:id/publish", "entry:publish", async (c, user, entry) => {
    const published = await publishEntry(orm, {
      id: entry.id,
      expectedRev: expectedRev(c),
      authorId: user.id,
      now: now(),
    });
    options.onSiteChanged(summaryJson(published).url ?? undefined);
    return c.json(entryJson(published));
  });

  entryRoute("post", "/entries/:id/unpublish", "entry:publish", async (c, _user, entry) => {
    const unpublished = await unpublishEntry(orm, {
      id: entry.id,
      expectedRev: expectedRev(c),
      now: now(),
    });
    options.onSiteChanged();
    return c.json(entryJson(unpublished));
  });

  entryRoute("post", "/entries/:id/trash", "entry:trash", async (c, _user, entry) => {
    const trashed = await trashEntry(orm, { id: entry.id, now: now() });
    options.onSiteChanged();
    return c.json(entryJson(trashed));
  });

  entryRoute("post", "/entries/:id/restore", "entry:trash", async (c, _user, entry) => {
    return c.json(entryJson(await restoreEntry(orm, { id: entry.id, now: now() })));
  });

  return { app, policies };
}
