import { eq } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { clientIp, rateLimitKey } from "../auth/client-ip.ts";
import { hashPassword, MAX_PASSWORD_LENGTH, passwordProblem } from "../auth/passwords.ts";
import { TokenBuckets } from "../auth/ratelimit.ts";
import type { Orm } from "../db/client.ts";
import { getSetting } from "../db/repo/settings.ts";
import {
  createResetLink,
  findRecoveryCode,
  findUsableToken,
  RECOVERED_MS,
  type Role,
  recoveryCodeId,
  recoveryKitStatus,
  replaceRecoveryKit,
  tokenId,
  useToken,
} from "../db/repo/tokens.ts";
import { findUserByEmail, type User } from "../db/repo/users.ts";
import { sessions, users } from "../db/schema.ts";
import { uuidv7 } from "../ids.ts";
import { parseBody, readJson } from "./admin/routing.ts";
import { ApiError, tooManyTries } from "./errors.ts";

// Getting into an account without the password you had (PLAN.md J5, J7 and §12): accepting
// an invite, choosing a new password from a reset link, and using a recovery code, which
// leads to the same new-password screen. Plus making a new recovery kit while signed in.

const RECOVER_TRIES_PER_MINUTE_PER_ADDRESS = 5;
const RECOVER_TRIES_PER_HOUR_PER_ACCOUNT = 10;
const WRONG_RESET_LINKS_PER_HOUR_PER_ADDRESS = 3;

export interface AccountRouteOptions {
  orm: Orm;
  secretKey: Buffer;
  trustProxy: number;
  now: () => number;
  startSession: (c: Context, user: Pick<User, "id" | "email">, hash: string) => Promise<void>;
  /** Whether this device has signed in to this account before. */
  isKnownDevice: (c: Context, email: string) => boolean;
  requireUser: (c: Context) => Promise<User>;
  /** Checks a signed-in person's own password, limited like signing in. Throws if wrong. */
  confirmPassword: (c: Context, user: User, password: string) => Promise<void>;
  publicUser: (user: User) => unknown;
}

const linkToken = z
  .string({ error: "That link isn't complete." })
  .min(16, "That link isn't complete.")
  .max(128, "That link isn't right.");

const newPassword = z.string({ error: "Choose a password." });

const acceptSchema = z.object({
  token: linkToken,
  name: z
    .string({ error: "Type your name." })
    .trim()
    .min(1, "Type your name.")
    .max(100, "Use 100 characters or fewer for your name."),
  password: newPassword,
});

const resetSchema = z.object({ token: linkToken, password: newPassword });
const checkSchema = z.object({ token: linkToken });

const recoverSchema = z.object({
  email: z
    .string({ error: "Type your email address." })
    .trim()
    .min(1, "Type your email address.")
    .max(254, "That email and recovery code don't match."),
  code: z
    .string({ error: "Type one of your recovery codes." })
    .trim()
    .min(1, "Type one of your recovery codes.")
    .max(64, "That email and recovery code don't match."),
});

const kitSchema = z.object({
  password: z
    .string({ error: "Type your password." })
    .min(1, "Type your password.")
    .max(MAX_PASSWORD_LENGTH * 4, "That isn't your password."),
});

function inviteGone(): ApiError {
  return new ApiError(404, "invite_unknown", "This invite link doesn't work any more.", {
    fix: "It may have been used already, or be more than a week old. Ask whoever invited you for a new one.",
  });
}

function resetGone(): ApiError {
  return new ApiError(404, "reset_unknown", "This link for a new password doesn't work any more.", {
    fix: "It may have been used already, or have run out. Ask whoever sent it for a new one, or use a recovery code.",
  });
}

function alreadyHere(): ApiError {
  return new ApiError(409, "already_here", "You can already sign in here with this email.", {
    fix: "Sign in instead. If you've forgotten your password, use Forgot password.",
  });
}

function recoverFailed(): ApiError {
  // The same words every time, so this doesn't reveal which emails have accounts.
  return new ApiError(401, "recovery_failed", "That email and recovery code don't match.", {
    fix: "Check them and try again. Each code works only once.",
  });
}

export function registerAccountRoutes(app: Hono, options: AccountRouteOptions): void {
  const { orm, secretKey, now } = options;
  const recoverPerAddress = new TokenBuckets({
    perMinute: RECOVER_TRIES_PER_MINUTE_PER_ADDRESS,
    now,
  });
  const recoverPerAccount = new TokenBuckets({
    perHour: RECOVER_TRIES_PER_HOUR_PER_ACCOUNT,
    now,
  });
  const wrongResetLinks = new TokenBuckets({
    perHour: WRONG_RESET_LINKS_PER_HOUR_PER_ADDRESS,
    now,
  });

  async function siteName(): Promise<string> {
    return (await getSetting(orm, "site"))?.name ?? "";
  }

  function checkNewPassword(
    password: string,
    person: { email: string; name: string },
    site: string,
  ) {
    const problem = passwordProblem(password, { ...person, siteName: site });
    if (problem) throw new ApiError(400, "needs_fixing", problem, { field: "password" });
  }

  // Invites (J5). The token is in the link's fragment, which browsers never send, so the
  // invite screen sends it here in the body.

  app.post("/invite/check", async (c) => {
    const { token } = parseBody(checkSchema, await readJson(c));
    const invite = findUsableToken(orm, "invite", tokenId(token), now());
    if (!invite) throw inviteGone();
    const inviter = invite.createdBy
      ? orm.select({ name: users.name }).from(users).where(eq(users.id, invite.createdBy)).get()
      : undefined;
    return c.json({
      site: await siteName(),
      email: invite.email,
      role: invite.role,
      invitedBy: inviter?.name ?? null,
    });
  });

  app.post("/invite/accept", async (c) => {
    const { token, name, password } = parseBody(acceptSchema, await readJson(c));
    const id = tokenId(token);
    const invite = findUsableToken(orm, "invite", id, now());
    if (!invite?.email || !invite.role) throw inviteGone();
    const email = invite.email;
    const role = invite.role as Role;
    checkNewPassword(password, { email, name }, await siteName());
    if (await findUserByEmail(orm, email)) throw alreadyHere();

    const passwordHash = await hashPassword(password);
    const userId = uuidv7(now());
    // Accepting uses the invite up, so the same link can't make a second account.
    const recoveryCodes = orm.transaction(
      (tx) => {
        if (!useToken(tx, id, now())) throw inviteGone();
        if (tx.select({ id: users.id }).from(users).where(eq(users.email, email)).get()) {
          throw alreadyHere();
        }
        tx.insert(users)
          .values({ id: userId, email, name, role, passwordHash, createdAt: now() })
          .run();
        return replaceRecoveryKit(tx, secretKey, { userId, now: now() });
      },
      { behavior: "immediate" },
    );
    await options.startSession(c, { id: userId, email }, passwordHash);
    const user = await findUserByEmail(orm, email);
    return c.json({ user: user && options.publicUser(user), recoveryCodes }, 201);
  });

  // A new password, from a link someone sent or one a recovery code led to (J7).

  /** Who a link is for. Links that don't work are counted, and ones that do aren't. */
  function resetFor(c: Context, token: string): { id: string; person: User } {
    const address = rateLimitKey(clientIp(c, options.trustProxy));
    const tries = wrongResetLinks.take(address);
    if (!tries.allowed) throw tooManyTries(tries.retryAfterSeconds);
    const id = tokenId(token);
    const reset = findUsableToken(orm, "reset", id, now());
    const person = reset?.userId
      ? orm.select().from(users).where(eq(users.id, reset.userId)).get()
      : undefined;
    if (!person || person.disabledAt !== null) throw resetGone();
    wrongResetLinks.refund(address);
    return { id, person };
  }

  app.post("/reset/check", async (c) => {
    const { token } = parseBody(checkSchema, await readJson(c));
    const { person } = resetFor(c, token);
    return c.json({ email: person.email, name: person.name, site: await siteName() });
  });

  app.post("/reset", async (c) => {
    const { token, password } = parseBody(resetSchema, await readJson(c));
    const { id, person } = resetFor(c, token);
    checkNewPassword(password, person, await siteName());
    const passwordHash = await hashPassword(password);
    // Every session ends with the old password: whoever might have had it is signed out.
    orm.transaction(
      (tx) => {
        if (!useToken(tx, id, now())) throw resetGone();
        // Not passwordResetAt: that lifts the lockout for a day, which is only safe for a
        // password Tend generated. They're signed in here, on a device that's known from now.
        tx.update(users).set({ passwordHash }).where(eq(users.id, person.id)).run();
        tx.delete(sessions).where(eq(sessions.userId, person.id)).run();
      },
      { behavior: "immediate" },
    );
    await options.startSession(c, person, passwordHash);
    return c.json({ user: options.publicUser({ ...person, passwordHash }) });
  });

  // A recovery code (J7): one of the eight in the kit, each good once. It's swapped for a
  // short-lived reset link, so choosing the new password is the same screen as above.
  app.post("/recover", async (c) => {
    const { email, code } = parseBody(recoverSchema, await readJson(c));
    const address = rateLimitKey(clientIp(c, options.trustProxy));
    const account = email.toLowerCase();
    const perAddress = recoverPerAddress.take(address);
    if (!perAddress.allowed) throw tooManyTries(perAddress.retryAfterSeconds);
    // Counted for the account wherever the tries come from, since a code is short. Not from a
    // device that has signed in to it before: otherwise someone's wrong tries, from anywhere,
    // could keep its owner from using the codes they have.
    const counted = !options.isKnownDevice(c, account);
    if (counted) {
      const perAccount = recoverPerAccount.take(account);
      if (!perAccount.allowed) throw tooManyTries(perAccount.retryAfterSeconds);
    }

    // Worked out either way, so an email with no account takes as long as one with.
    recoveryCodeId(secretKey, code);
    const person = await findUserByEmail(orm, account);
    const found =
      person && person.disabledAt === null
        ? findRecoveryCode(orm, secretKey, { userId: person.id, code, now: now() })
        : undefined;
    if (!person || !found) throw recoverFailed();
    const { token } = orm.transaction(
      (tx) => {
        if (!useToken(tx, found.id, now())) throw recoverFailed();
        return createResetLink(tx, {
          userId: person.id,
          createdBy: person.id,
          now: now(),
          lastsMs: RECOVERED_MS,
        });
      },
      { behavior: "immediate" },
    );
    recoverPerAddress.refund(address);
    if (counted) recoverPerAccount.refund(account);
    return c.json({ token, codesLeft: recoveryKitStatus(orm, person.id, now()).codesLeft });
  });

  // The recovery kit, from Account. A new one needs the password, so a session someone
  // else got hold of can't be turned into a way back in.

  app.get("/recovery-kit", async (c) => {
    const user = await options.requireUser(c);
    return c.json(recoveryKitStatus(orm, user.id, now()));
  });

  app.post("/recovery-kit", async (c) => {
    const user = await options.requireUser(c);
    const { password } = parseBody(kitSchema, await readJson(c));
    await options.confirmPassword(c, user, password);
    const codes = orm.transaction((tx) =>
      replaceRecoveryKit(tx, secretKey, { userId: user.id, now: now() }),
    );
    return c.json({ codes }, 201);
  });
}
