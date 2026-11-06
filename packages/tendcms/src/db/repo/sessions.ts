import { createHash, randomBytes } from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import type { Orm } from "../client.ts";
import { sessions, users } from "../schema.ts";
import type { User } from "./users.ts";

const SLIDING_MS = 14 * 24 * 60 * 60 * 1000;
export const ABSOLUTE_MS = 60 * 24 * 60 * 60 * 1000;
// Extending on every request would mean a database write per request.
const EXTEND_AFTER_MS = 60 * 60 * 1000;

function tokenId(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Starts a session, but only if the password is still the one just checked. Checking
 * takes a moment, and a reset landing in that gap has to win: it promises to sign the
 * account out everywhere, so no session may appear after it. Returns null if it lost.
 */
export async function createSessionIfPasswordUnchanged(
  orm: Orm,
  input: {
    userId: string;
    verifiedHash: string;
    userAgent: string | null;
    ipPrefix: string | null;
    now: number;
  },
): Promise<string | null> {
  const token = randomBytes(32).toString("base64url");
  return orm.transaction(
    (tx) => {
      const user = tx
        .select({ passwordHash: users.passwordHash, disabledAt: users.disabledAt })
        .from(users)
        .where(eq(users.id, input.userId))
        .get();
      if (user?.passwordHash !== input.verifiedHash || user.disabledAt !== null) return null;

      tx.delete(sessions)
        .where(and(eq(sessions.userId, input.userId), lt(sessions.expiresAt, input.now)))
        .run();
      tx.insert(sessions)
        .values({
          id: tokenId(token),
          userId: input.userId,
          createdAt: input.now,
          lastUsedAt: input.now,
          expiresAt: input.now + SLIDING_MS,
          userAgent: input.userAgent,
          ipPrefix: input.ipPrefix,
        })
        .run();
      return token;
    },
    { behavior: "immediate" },
  );
}

/** The signed-in person for a token, extending the session if it's in use. */
export async function findSessionUser(
  orm: Orm,
  token: string,
  now: number,
): Promise<User | undefined> {
  const id = tokenId(token);
  const row = orm
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.id, id))
    .get();
  if (!row || row.session.expiresAt <= now || row.user.disabledAt !== null) return undefined;

  if (now - row.session.lastUsedAt > EXTEND_AFTER_MS) {
    const expiresAt = Math.min(now + SLIDING_MS, row.session.createdAt + ABSOLUTE_MS);
    orm.update(sessions).set({ lastUsedAt: now, expiresAt }).where(eq(sessions.id, id)).run();
  }
  return row.user;
}

export async function deleteSession(orm: Orm, token: string): Promise<void> {
  orm
    .delete(sessions)
    .where(eq(sessions.id, tokenId(token)))
    .run();
}

export async function deleteUserSessions(orm: Orm, userId: string): Promise<void> {
  orm.delete(sessions).where(eq(sessions.userId, userId)).run();
}
