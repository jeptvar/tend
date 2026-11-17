import type { User } from "../db/repo/users.ts";

export type Actor = Pick<User, "id" | "role" | "isOwner">;

export type Action =
  | "entry:list"
  | "entry:create"
  | "entry:read"
  | "entry:update"
  | "entry:publish"
  | "entry:trash"
  | "entry:delete"
  | "media:list"
  | "media:upload"
  | "media:update"
  | "media:replace"
  | "media:trash"
  | "media:delete"
  | "tag:list"
  | "tag:create"
  | "menu:manage"
  | "design:manage"
  | "settings:manage"
  | "backup:download";

export interface Subject {
  /** Who made it: the author of a post, or whoever uploaded a file. */
  authorId: string | null;
  /** "post" or "page", for something that's one of those. */
  type?: string | undefined;
}

/** What an Editor can do: everything about content, and the menu, but not run the site. */
const EDITOR_ACTIONS = new Set<Action>([
  "entry:list",
  "entry:create",
  "entry:read",
  "entry:update",
  "entry:publish",
  "entry:trash",
  "media:list",
  "media:upload",
  "media:update",
  // A new file in the same place: every page showing it changes at once, and the old file
  // is gone for good. So it's for someone who could publish those pages themselves.
  "media:replace",
  "media:trash",
  "tag:list",
  "tag:create",
  "menu:manage",
]);

/** Only for whoever runs the site: things that can't be undone, and how the whole site works. */
const ADMIN_ONLY_ACTIONS = new Set<Action>([
  "entry:delete",
  "media:delete",
  "design:manage",
  "settings:manage",
]);

/**
 * Only for the Owner. A backup holds every account's password hash and the site's secret
 * key, so taking one away is theirs to do, like restoring one (PLAN.md §6).
 */
const OWNER_ONLY_ACTIONS = new Set<Action>(["backup:download"]);

/**
 * A Writer (v0.3) works on their own posts, adds pictures and describes their own, and can't
 * publish (PLAN.md §6). Media's routes also stop them describing a picture the site already
 * shows, since that would reach visitors without anyone looking it over.
 */
const WRITER_ACTIONS = new Set<Action>([
  "entry:list",
  "entry:create",
  "media:list",
  "media:upload",
  "tag:list",
]);
const WRITER_OWN_ACTIONS = new Set<Action>(["entry:read", "entry:update", "media:update"]);

/**
 * The one place that decides who can do what (PLAN.md §12), and deny is the default:
 * an action nobody listed is refused. The admin only hides controls. This is what
 * actually stops anyone.
 */
export function can(actor: Actor | null | undefined, action: Action, subject?: Subject): boolean {
  if (!actor) return false;
  if (OWNER_ONLY_ACTIONS.has(action)) return actor.role === "admin" && Boolean(actor.isOwner);
  switch (actor.role) {
    case "admin":
      return EDITOR_ACTIONS.has(action) || ADMIN_ONLY_ACTIONS.has(action);
    case "editor":
      return EDITOR_ACTIONS.has(action);
    case "writer": {
      // Pages are how the site itself is laid out, which isn't a Writer's to change.
      if (subject?.type === "page") return false;
      if (WRITER_ACTIONS.has(action)) return true;
      const ownsIt = subject !== undefined && subject.authorId === actor.id;
      return ownsIt && WRITER_OWN_ACTIONS.has(action);
    }
    default:
      return false;
  }
}

/** Whether a list should show only this person's own entries. */
export function seesOnlyOwnEntries(actor: Actor): boolean {
  return actor.role === "writer";
}
