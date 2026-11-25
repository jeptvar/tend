import { and, eq } from "drizzle-orm";
import type { Orm } from "../client.ts";
import { sessions, users } from "../schema.ts";
import { revokeResetLinks } from "./tokens.ts";

export type User = typeof users.$inferSelect;

export async function ownerExists(orm: Orm): Promise<boolean> {
  return orm.select({ id: users.id }).from(users).where(eq(users.isOwner, 1)).get() !== undefined;
}

/** Emails compare case-insensitively, because the column is COLLATE NOCASE. */
export async function findUserByEmail(orm: Orm, email: string): Promise<User | undefined> {
  return orm.select().from(users).where(eq(users.email, email)).get();
}

export async function listUsers(orm: Orm): Promise<Pick<User, "email" | "isOwner">[]> {
  return orm.select({ email: users.email, isOwner: users.isOwner }).from(users).all();
}

/**
 * Swaps a hash for a stronger one of the same password, but only if it's still the
 * hash that was just checked: a reset in between must not be undone by this.
 */
export async function upgradePasswordHash(
  orm: Orm,
  userId: string,
  verifiedHash: string,
  passwordHash: string,
): Promise<void> {
  orm
    .update(users)
    .set({ passwordHash })
    .where(and(eq(users.id, userId), eq(users.passwordHash, verifiedHash)))
    .run();
}

export async function touchLastSeen(orm: Orm, userId: string, now: number): Promise<void> {
  orm.update(users).set({ lastSeenAt: now }).where(eq(users.id, userId)).run();
}

/**
 * A new password ends every session and takes back any reset link, in one step, so nothing
 * from before survives the change.
 */
export async function resetPasswordAndSignOutEverywhere(
  orm: Orm,
  userId: string,
  passwordHash: string,
  now: number,
): Promise<void> {
  orm.transaction(
    (tx) => {
      tx.update(users)
        .set({ passwordHash, passwordResetAt: now })
        .where(eq(users.id, userId))
        .run();
      tx.delete(sessions).where(eq(sessions.userId, userId)).run();
      revokeResetLinks(tx, userId, now);
    },
    { behavior: "immediate" },
  );
}

/**
 * Someone's own new password, unless it was changed since `verifiedHash` was checked. Every
 * session ends with the old one: whoever might have had it is signed out.
 */
export function changePassword(
  orm: Orm,
  input: { userId: string; verifiedHash: string; passwordHash: string; now: number },
): boolean {
  return orm.transaction(
    (tx) => {
      const changed = tx
        .update(users)
        .set({ passwordHash: input.passwordHash })
        .where(and(eq(users.id, input.userId), eq(users.passwordHash, input.verifiedHash)))
        .returning({ id: users.id })
        .get();
      if (!changed) return false;
      tx.delete(sessions).where(eq(sessions.userId, input.userId)).run();
      revokeResetLinks(tx, input.userId, input.now);
      return true;
    },
    { behavior: "immediate" },
  );
}

/**
 * Hands the site over: someone else becomes the Owner, and whoever was stays an Admin. False
 * if either of them has changed since they were looked at.
 */
export function transferOwnership(
  orm: Orm,
  input: { from: string; to: string; now: number },
): boolean {
  return orm.transaction(
    (tx) => {
      const target = tx.select().from(users).where(eq(users.id, input.to)).get();
      if (!target || target.disabledAt !== null || target.isOwner) return false;
      // In this order, because only one person can be the Owner at any moment.
      const given = tx
        .update(users)
        .set({ isOwner: 0 })
        .where(and(eq(users.id, input.from), eq(users.isOwner, 1)))
        .returning({ id: users.id })
        .get();
      if (!given) return false;
      tx.update(users).set({ isOwner: 1, role: "admin" }).where(eq(users.id, input.to)).run();
      // An Admin can make a reset link for an Editor. One still waiting mustn't become a way
      // into the Owner's account.
      revokeResetLinks(tx, input.to, input.now);
      if (target.role !== "admin") {
        tx.delete(sessions).where(eq(sessions.userId, input.to)).run();
      }
      return true;
    },
    { behavior: "immediate" },
  );
}
