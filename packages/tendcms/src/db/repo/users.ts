import { and, eq } from "drizzle-orm";
import type { Orm } from "../client.ts";
import { sessions, users } from "../schema.ts";

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

/** A new password ends every session, in one step, so no old one survives the change. */
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
    },
    { behavior: "immediate" },
  );
}
