import type { User } from "../db/repo/users.ts";

export type Actor = Pick<User, "id" | "role" | "isOwner">;

export type Action =
  | "entry:list"
  | "entry:create"
  | "entry:read"
  | "entry:update"
  | "entry:publish"
  | "entry:trash";

export interface Subject {
  authorId: string | null;
}

/**
 * The one place that decides who can do what (PLAN.md §12), and deny is the default:
 * an action nobody listed is refused. The admin only hides controls. This is what
 * actually stops anyone.
 */
export function can(actor: Actor | null | undefined, action: Action, subject?: Subject): boolean {
  if (!actor) return false;
  switch (actor.role) {
    case "admin":
    case "editor":
      return (
        action === "entry:list" ||
        action === "entry:create" ||
        action === "entry:read" ||
        action === "entry:update" ||
        action === "entry:publish" ||
        action === "entry:trash"
      );
    case "writer": {
      if (action === "entry:list" || action === "entry:create") return true;
      const ownsIt = subject !== undefined && subject.authorId === actor.id;
      return ownsIt && (action === "entry:read" || action === "entry:update");
    }
    default:
      return false;
  }
}

/** Whether a list should show only this person's own entries. */
export function seesOnlyOwnEntries(actor: Actor): boolean {
  return actor.role === "writer";
}
