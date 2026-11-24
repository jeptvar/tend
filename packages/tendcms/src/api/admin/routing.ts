import { type Context, Hono } from "hono";
import type { z } from "zod";
import { currentUser } from "../../auth/current-user.ts";
import { type Action, can, type Subject } from "../../auth/policy.ts";
import type { Orm } from "../../db/client.ts";
import type { User } from "../../db/repo/users.ts";
import type { MediaStore } from "../../media/store.ts";
import type { PreviewInput } from "../../site/router.ts";
import type { SiteAddress } from "../../site-address.ts";
import { ApiError } from "../errors.ts";

export interface AdminOptions {
  orm: Orm;
  store: MediaStore;
  address: SiteAddress;
  now?: (() => number) | undefined;
  /** Called after anything that changes what visitors see. */
  onSiteChanged: (changedPath?: string) => void;
  /** How something would look on the site. Missing only in tests that don't need it. */
  preview?: ((input: PreviewInput) => Promise<string>) | undefined;
}

/** What a route loads and checks its action against. */
export type SubjectKind = "entry" | "revision" | "media";

export interface RoutePolicy {
  method: string;
  path: string;
  action: Action;
  subject: SubjectKind | null;
}

type Method = "get" | "post" | "put" | "patch" | "delete";
type Handler<Args extends unknown[]> = (c: Context, user: User, ...args: Args) => Promise<Response>;

export interface SubjectLoader<S> {
  kind: SubjectKind;
  load: (c: Context) => Promise<S | undefined>;
  missing: () => ApiError;
  /** Whose it is, for actions only its owner may take. */
  owner: (subject: S) => Subject;
}

/** The pieces every admin route is built from, so each one has to state what guards it. */
export interface Routing {
  app: Hono;
  policies: RoutePolicy[];
  now: () => number;
  refuse(): ApiError;
  /** A route with no particular thing involved. */
  route(method: Method, path: string, action: Action, handler: Handler<[]>): void;
  /** A route about one thing, checked against that thing. */
  subjectRoute<S>(
    method: Method,
    path: string,
    action: Action,
    subject: SubjectLoader<S>,
    handler: Handler<[S]>,
  ): void;
}

/** The answer for anyone not signed in, wherever it's found out first. */
export function notSignedIn(): ApiError {
  return new ApiError(401, "not_signed_in", "You're not signed in.", {
    fix: "Sign in again to carry on.",
  });
}

export function createRouting(options: {
  orm: Orm;
  address: SiteAddress;
  now?: (() => number) | undefined;
}): Routing {
  const now = options.now ?? Date.now;
  const app = new Hono();
  const policies: RoutePolicy[] = [];

  async function requireUser(c: Context): Promise<User> {
    const user = await currentUser(c, options.orm, options.address.secure, now());
    if (!user) throw notSignedIn();
    return user;
  }

  function refuse(): ApiError {
    return new ApiError(403, "not_allowed", "Your account can't do that.", {
      fix: "Ask whoever runs this site.",
    });
  }

  return {
    app,
    policies,
    now,
    refuse,
    route(method, path, action, handler) {
      policies.push({ method: method.toUpperCase(), path, action, subject: null });
      app[method](path, async (c) => {
        const user = await requireUser(c);
        if (!can(user, action)) throw refuse();
        return handler(c, user);
      });
    },
    subjectRoute(method, path, action, subject, handler) {
      policies.push({ method: method.toUpperCase(), path, action, subject: subject.kind });
      app[method](path, async (c) => {
        const user = await requireUser(c);
        const found = await subject.load(c);
        if (found === undefined) throw subject.missing();
        if (!can(user, action, subject.owner(found))) throw refuse();
        return handler(c, user, found);
      });
    },
  };
}

/** For a check with no message of its own, which would otherwise show the library's words. */
const FALLBACK_PROBLEM = "Tend couldn't save that, because part of it isn't in a form it expects.";
const FALLBACK_FIX = "Reload this page, then try again.";

export function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body, { error: () => FALLBACK_PROBLEM });
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
    ...(message === FALLBACK_PROBLEM ? { fix: FALLBACK_FIX } : {}),
  });
}

export async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new ApiError(400, "unreadable_request", "Tend couldn't read that request. Try again.");
  }
}

/** Where a page of a list starts. */
export function offsetFrom(c: Context): number {
  const parsed = Number.parseInt(c.req.query("cursor") ?? "0", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}
