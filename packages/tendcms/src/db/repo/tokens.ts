import { createHash, createHmac, randomBytes } from "node:crypto";
import { and, asc, desc, eq, gt, isNull, or } from "drizzle-orm";
import { normalizeCrockford, randomCrockford } from "../../auth/crockford.ts";
import type { Orm } from "../client.ts";
import { tokens, users } from "../schema.ts";
import type { User } from "./users.ts";

// Invites, reset links and recovery codes (PLAN.md §12). Each works once. A link carries a
// random token, and only its SHA-256 is kept. A recovery code is short enough to type, so
// it's kept as an HMAC with the site's key: a copy of the database alone can't test guesses.

export type Token = typeof tokens.$inferSelect;
export type Role = User["role"];

const DAY_MS = 24 * 60 * 60 * 1000;
/** An invite link works for a week (J5). */
export const INVITE_MS = 7 * DAY_MS;
/** A reset link someone sends works for a day. */
export const RESET_LINK_MS = DAY_MS;
/** After a recovery code, the new password has to be chosen within half an hour. */
export const RECOVERED_MS = 30 * 60 * 1000;
/** How many codes a recovery kit holds. */
export const RECOVERY_CODES = 8;
const RECOVERY_CODE_LENGTH = 10;

/** For something that may run inside a transaction or not. */
type Db = Pick<Orm, "select" | "insert" | "update">;

export function tokenId(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** A token for a link: 256 random bits. It's shown once and kept only as its hash. */
function newLinkToken(): { token: string; id: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, id: tokenId(token) };
}

export function recoveryCodeId(secretKey: Buffer, code: string): string {
  return createHmac("sha256", secretKey)
    .update(`tend:recovery:${normalizeCrockford(code)}`)
    .digest("hex");
}

/** Ten Crockford characters, about 50 bits, shown as XXXXX-XXXXX. */
function newRecoveryCode(): string {
  const code = randomCrockford(RECOVERY_CODE_LENGTH);
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

/** Not used, not taken back, and not out of date. */
function usable(now: number) {
  return and(
    isNull(tokens.usedAt),
    isNull(tokens.revokedAt),
    or(isNull(tokens.expiresAt), gt(tokens.expiresAt, now)),
  );
}

export function findUsableToken(
  db: Db,
  kind: Token["kind"],
  id: string,
  now: number,
): Token | undefined {
  return db
    .select()
    .from(tokens)
    .where(and(eq(tokens.id, id), eq(tokens.kind, kind), usable(now)))
    .get();
}

/**
 * Marks a token used, if it still can be. Run in the transaction that does what it allows,
 * so two requests with the same token can't both get through.
 */
export function useToken(db: Db, id: string, now: number): boolean {
  const used = db
    .update(tokens)
    .set({ usedAt: now })
    .where(and(eq(tokens.id, id), usable(now)))
    .returning({ id: tokens.id })
    .get();
  return used !== undefined;
}

/** A new invite for this email, which takes the place of any it had. */
export function createInvite(
  orm: Orm,
  input: { email: string; role: Role; createdBy: string; now: number },
): { token: string; invite: Token } {
  const { token, id } = newLinkToken();
  const invite = orm.transaction((tx) => {
    tx.update(tokens)
      .set({ revokedAt: input.now })
      .where(and(eq(tokens.kind, "invite"), eq(tokens.email, input.email), usable(input.now)))
      .run();
    return tx
      .insert(tokens)
      .values({
        id,
        kind: "invite",
        email: input.email,
        role: input.role,
        createdBy: input.createdBy,
        createdAt: input.now,
        expiresAt: input.now + INVITE_MS,
      })
      .returning()
      .get();
  });
  return { token, invite };
}

export interface PendingInvite extends Token {
  invitedBy: string | null;
}

/** Invites that can still be accepted, newest first. */
export function pendingInvites(orm: Orm, now: number): PendingInvite[] {
  return orm
    .select({ token: tokens, invitedBy: users.name })
    .from(tokens)
    .leftJoin(users, eq(tokens.createdBy, users.id))
    .where(and(eq(tokens.kind, "invite"), usable(now)))
    .orderBy(desc(tokens.createdAt))
    .all()
    .map((row) => ({ ...row.token, invitedBy: row.invitedBy }));
}

export function revokeToken(orm: Orm, id: string, now: number): void {
  orm.update(tokens).set({ revokedAt: now }).where(eq(tokens.id, id)).run();
}

/**
 * A link that lets someone choose a new password, which takes the place of any earlier one.
 * `createdBy` is whoever sent it, or the person themselves after using a recovery code.
 */
export function createResetLink(
  db: Db,
  input: { userId: string; createdBy: string; now: number; lastsMs: number },
): { token: string; expiresAt: number } {
  const { token, id } = newLinkToken();
  const expiresAt = input.now + input.lastsMs;
  db.update(tokens)
    .set({ revokedAt: input.now })
    .where(and(eq(tokens.kind, "reset"), eq(tokens.userId, input.userId), usable(input.now)))
    .run();
  db.insert(tokens)
    .values({
      id,
      kind: "reset",
      userId: input.userId,
      createdBy: input.createdBy,
      createdAt: input.now,
      expiresAt,
    })
    .run();
  return { token, expiresAt };
}

/**
 * Takes back any reset link someone has waiting. A link made for the person they were, with
 * the password or role they had, mustn't work on the person they've become.
 */
export function revokeResetLinks(db: Db, userId: string, now: number): void {
  db.update(tokens)
    .set({ revokedAt: now })
    .where(and(eq(tokens.kind, "reset"), eq(tokens.userId, userId), usable(now)))
    .run();
}

/** A new recovery kit for someone. The codes in their old one stop working. */
export function replaceRecoveryKit(
  db: Db,
  secretKey: Buffer,
  input: { userId: string; now: number },
): string[] {
  db.update(tokens)
    .set({ revokedAt: input.now })
    .where(and(eq(tokens.kind, "recovery"), eq(tokens.userId, input.userId), usable(input.now)))
    .run();
  const codes = Array.from({ length: RECOVERY_CODES }, newRecoveryCode);
  db.insert(tokens)
    .values(
      codes.map((code) => ({
        id: recoveryCodeId(secretKey, code),
        kind: "recovery" as const,
        userId: input.userId,
        createdBy: input.userId,
        createdAt: input.now,
      })),
    )
    .run();
  return codes;
}

/** How many codes someone's kit has left, and when it was made: null if they've none. */
export function recoveryKitStatus(
  orm: Orm,
  userId: string,
  now: number,
): { codesLeft: number; madeAt: number | null } {
  const left = orm
    .select({ createdAt: tokens.createdAt })
    .from(tokens)
    .where(and(eq(tokens.kind, "recovery"), eq(tokens.userId, userId), usable(now)))
    .orderBy(asc(tokens.createdAt))
    .all();
  return { codesLeft: left.length, madeAt: left.at(-1)?.createdAt ?? null };
}

/** Someone's usable recovery code, if this is one. */
export function findRecoveryCode(
  orm: Orm,
  secretKey: Buffer,
  input: { userId: string; code: string; now: number },
): Token | undefined {
  const token = findUsableToken(orm, "recovery", recoveryCodeId(secretKey, input.code), input.now);
  return token?.userId === input.userId ? token : undefined;
}
