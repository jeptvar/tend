import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { clientIp, networkKey, rateLimitKey, storedIpPrefix } from "../auth/client-ip.ts";
import { currentUser, deviceCookieName, sessionCookieName } from "../auth/current-user.ts";
import {
  createDeviceCookie,
  DEVICE_COOKIE_MAX_AGE_SECONDS,
  deviceCookieIsValid,
} from "../auth/device-cookie.ts";
import {
  hashPassword,
  MAX_PASSWORD_LENGTH,
  needsRehash,
  passwordProblem,
  spendVerifyTime,
  verifyPassword,
} from "../auth/passwords.ts";
import { AccountBackoff, TokenBuckets, WorkGate } from "../auth/ratelimit.ts";
import { completeSetup, loadStarter, SetupClosedError } from "../auth/setup.ts";
import { type SetupCodeSource, setupCodeMatches } from "../auth/setup-code.ts";
import type { Orm } from "../db/client.ts";
import {
  ABSOLUTE_MS,
  createSessionIfPasswordUnchanged,
  deleteSession,
  deleteUserSessions,
} from "../db/repo/sessions.ts";
import { getSetting } from "../db/repo/settings.ts";
import {
  findUserByEmail,
  ownerExists,
  touchLastSeen,
  type User,
  upgradePasswordHash,
} from "../db/repo/users.ts";
import { ApiError, tendIsBusy, tooManyTries } from "./errors.ts";

export interface AuthOptions extends SetupCodeSource {
  orm: Orm;
  secureCookies: boolean;
  trustProxy: number;
  now?: () => number;
  /** How many made-up emails to remember. Only tests change this. */
  unknownEmailKeys?: number;
  themeDir: string;
  onSiteChanged: () => void;
  /** Whether the site has a real public address. */
  isPublic: boolean;
}

const SETUP_CODE_ATTEMPTS_PER_MINUTE = 5;
const LOGIN_ATTEMPTS_PER_MINUTE_PER_ACCOUNT = 5;
const LOGIN_ATTEMPTS_PER_MINUTE_PER_ADDRESS = 20;
const LOGIN_ATTEMPTS_PER_MINUTE_PER_NETWORK = 120;
// Argon2 runs on a small thread pool, so a short queue is all that's useful.
const PASSWORD_CHECKS_AT_ONCE = 6;
const PASSWORD_CHECKS_RESERVED_FOR_KNOWN_DEVICES = 2;
// A generated password can't be guessed, so for a while after a reset it's safe to
// ignore lockouts. Otherwise someone guessing could keep the real owner out for good.
const LOCKOUT_LIFTED_AFTER_RESET_MS = 24 * 60 * 60 * 1000;

const codeSchema = z.object({
  code: z.string({ error: "Type your setup code." }).min(1, "Type your setup code.").max(256),
});

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function isLocale(value: string): boolean {
  try {
    return Intl.getCanonicalLocales(value).length === 1;
  } catch {
    return false;
  }
}

const setupSchema = z.object({
  site: z.object({
    name: z
      .string({ error: "Type a name for your site." })
      .trim()
      .min(1, "Type a name for your site.")
      .max(100, "Use 100 characters or fewer for your site's name."),
    tagline: z
      .string()
      .trim()
      .max(200, "Use 200 characters or fewer for your tagline.")
      .default(""),
    // These come from the browser, so if they're unusable, fall back rather than stop setup.
    locale: z.string().max(64).refine(isLocale).catch("en"),
    timezone: z.string().max(64).refine(isTimeZone).catch("UTC"),
  }),
  owner: z.object({
    name: z
      .string({ error: "Type your name." })
      .trim()
      .min(1, "Type your name.")
      .max(100, "Use 100 characters or fewer for your name."),
    email: z
      .string({ error: "Type your email address." })
      .trim()
      .toLowerCase()
      .max(254, "That email address is too long.")
      .pipe(
        z.email("That doesn't look like an email address. It should look like you@example.com."),
      ),
    password: z.string({ error: "Choose a password." }),
  }),
  starter: z.enum(["blog", "business", "blank"], { error: "Pick a starting point." }),
});

const loginSchema = z.object({
  email: z
    .string({ error: "Type your email address." })
    .trim()
    .min(1, "Type your email address.")
    .max(254, "That email and password don't match."),
  password: z
    .string({ error: "Type your password." })
    .min(1, "Type your password.")
    .max(MAX_PASSWORD_LENGTH * 4, "That email and password don't match."),
});

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  throw new ApiError(400, "needs_fixing", issue?.message ?? "Check what you typed and try again.", {
    field: issue?.path.join("."),
  });
}

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new ApiError(400, "unreadable_request", "Tend couldn't read that request. Try again.");
  }
}

function publicUser(user: User) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    isOwner: user.isOwner === 1,
  };
}

/** Sessions, sign-in and first-run setup: everything under /api/auth. */
export function createAuthRoutes(options: AuthOptions): Hono {
  const { orm, secureCookies, trustProxy, secretKey } = options;
  const now = options.now ?? Date.now;
  const clock = { now };

  const sessionCookie = sessionCookieName(secureCookies);
  const deviceCookie = deviceCookieName(secureCookies);
  const cookieBase = { httpOnly: true, sameSite: "Lax", path: "/", secure: secureCookies } as const;

  const setupCodeAttempts = new TokenBuckets({
    perMinute: SETUP_CODE_ATTEMPTS_PER_MINUTE,
    ...clock,
  });
  const loginAttemptsPerAccount = new TokenBuckets({
    perMinute: LOGIN_ATTEMPTS_PER_MINUTE_PER_ACCOUNT,
    ...clock,
  });
  const loginAttemptsPerAddress = new TokenBuckets({
    perMinute: LOGIN_ATTEMPTS_PER_MINUTE_PER_ADDRESS,
    ...clock,
  });
  const loginAttemptsPerNetwork = new TokenBuckets({
    perMinute: LOGIN_ATTEMPTS_PER_MINUTE_PER_NETWORK,
    ...clock,
  });
  // Real accounts have their own map, never trimmed (the users table bounds it), so a
  // flood of made-up emails can't push an account's lockout out of memory.
  const accountGuesses = new AccountBackoff({ maxKeys: Number.POSITIVE_INFINITY, ...clock });
  const unknownEmailGuesses = new AccountBackoff({ maxKeys: options.unknownEmailKeys, ...clock });
  // A known device skips the account lockout, but not without limit: one copied from a
  // shared computer shouldn't get endless guesses. There's no reset, because every
  // successful sign-in hands out a new cookie, which starts from zero.
  const knownDeviceGuesses = new AccountBackoff(clock);
  const passwordChecks = new WorkGate({
    limit: PASSWORD_CHECKS_AT_ONCE,
    reservedForPriority: PASSWORD_CHECKS_RESERVED_FOR_KNOWN_DEVICES,
  });

  function loginFailed(): ApiError {
    // The same words every time, so this doesn't reveal which emails have accounts.
    return new ApiError(401, "login_failed", "That email and password don't match.", {
      fix: "Check them and try again, or use Forgot password.",
    });
  }

  /** Signs someone in, unless the password changed since `verifiedHash` was checked. */
  async function startSession(
    c: Context,
    user: Pick<User, "id" | "email">,
    verifiedHash: string,
  ): Promise<void> {
    const ip = clientIp(c, trustProxy);
    const token = await createSessionIfPasswordUnchanged(orm, {
      userId: user.id,
      verifiedHash,
      userAgent: c.req.header("user-agent")?.slice(0, 200) ?? null,
      ipPrefix: storedIpPrefix(ip),
      now: now(),
    });
    if (!token) throw loginFailed();
    setCookie(c, sessionCookie, token, { ...cookieBase, maxAge: ABSOLUTE_MS / 1000 });
    setCookie(c, deviceCookie, createDeviceCookie(secretKey, user.email.toLowerCase(), now()), {
      ...cookieBase,
      maxAge: DEVICE_COOKIE_MAX_AGE_SECONDS,
    });
  }

  async function requireUser(c: Context): Promise<User> {
    const user = await currentUser(c, orm, secureCookies, now());
    if (!user) {
      throw new ApiError(401, "not_signed_in", "You're not signed in.", {
        fix: "Sign in again. What you've typed stays in this tab.",
      });
    }
    return user;
  }

  /** Checks the setup code, counting only wrong guesses against the visitor's address. */
  function requireSetupCode(c: Context, code: string): void {
    const key = rateLimitKey(clientIp(c, trustProxy));
    const limit = setupCodeAttempts.take(key);
    if (!limit.allowed) throw tooManyTries(limit.retryAfterSeconds);
    if (!setupCodeMatches(code, options)) {
      if (options.setupPassword !== undefined) {
        throw new ApiError(401, "setup_code_wrong", "That setup password doesn't match.", {
          field: "code",
          fix: "Use the one you chose when you created this copy of Tend.",
        });
      }
      throw new ApiError(401, "setup_code_wrong", "That setup code doesn't match.", {
        field: "code",
        fix: "It's shown where Tend is running: in its window, or in your host's logs.",
      });
    }
    setupCodeAttempts.refund(key);
  }

  async function requireSetupOpen(): Promise<void> {
    if (await ownerExists(orm)) {
      throw new ApiError(409, "setup_closed", "This site is already set up.", {
        fix: "Sign in instead.",
      });
    }
  }

  const app = new Hono();

  app.get("/setup/status", async (c) =>
    c.json({
      needsSetup: !(await ownerExists(orm)),
      codeKind: options.setupPassword === undefined ? "code" : "password",
    }),
  );

  app.post("/setup/check-code", async (c) => {
    await requireSetupOpen();
    requireSetupCode(c, parse(codeSchema, await readJson(c)).code);
    return c.body(null, 204);
  });

  app.post("/setup", async (c) => {
    await requireSetupOpen();
    const body = await readJson(c);
    // The code comes first, so nothing else is revealed or hashed without it.
    requireSetupCode(c, parse(codeSchema, body).code);

    const { site, owner, starter } = parse(setupSchema, body);
    const problem = passwordProblem(owner.password, {
      email: owner.email,
      name: owner.name,
      siteName: site.name,
    });
    if (problem) throw new ApiError(400, "needs_fixing", problem, { field: "owner.password" });

    const passwordHash = await hashPassword(owner.password);
    let userId: string;
    try {
      userId = completeSetup(orm, {
        site,
        owner: { name: owner.name, email: owner.email, passwordHash },
        starter,
        starterEntries: loadStarter(options.themeDir, starter, site.name),
        now: now(),
      });
    } catch (error) {
      if (error instanceof SetupClosedError) await requireSetupOpen();
      throw error;
    }

    options.onSiteChanged();
    await startSession(c, { id: userId, email: owner.email }, passwordHash);
    const user = await findUserByEmail(orm, owner.email);
    return c.json({ user: user && publicUser(user) }, 201);
  });

  app.post("/login", async (c) => {
    const { email: typedEmail, password } = parse(loginSchema, await readJson(c));
    const email = typedEmail.toLowerCase();
    const ip = clientIp(c, trustProxy);
    const addressKey = rateLimitKey(ip);
    const accountKey = `${addressKey}|${email}`;

    const perAddress = loginAttemptsPerAddress.take(addressKey);
    if (!perAddress.allowed) throw tooManyTries(perAddress.retryAfterSeconds);
    const perAccount = loginAttemptsPerAccount.take(accountKey);
    if (!perAccount.allowed) throw tooManyTries(perAccount.retryAfterSeconds);
    const network = networkKey(ip);
    if (network) {
      const perNetwork = loginAttemptsPerNetwork.take(network);
      if (!perNetwork.allowed) throw tooManyTries(perNetwork.retryAfterSeconds);
    }

    const user = await findUserByEmail(orm, email);
    const device = getCookie(c, deviceCookie);
    const knownDevice =
      device !== undefined &&
      deviceCookieIsValid(secretKey, device, email, now()) &&
      knownDeviceGuesses.retryAfterSeconds(device) === 0;
    const justReset =
      user?.passwordResetAt != null && now() - user.passwordResetAt < LOCKOUT_LIFTED_AFTER_RESET_MS;
    const guesses = user ? accountGuesses : unknownEmailGuesses;
    const guessKey = user?.id ?? email;

    const skipLockout = knownDevice || justReset;
    if (!skipLockout) {
      const wait = guesses.retryAfterSeconds(guessKey);
      if (wait > 0) throw tooManyTries(wait);
    }
    if (!passwordChecks.tryEnter(knownDevice)) throw tendIsBusy();

    // Counted before checking and undone on success. Checking takes a while, so counting
    // afterwards would let a burst of parallel guesses all past the lock.
    if (knownDevice) knownDeviceGuesses.recordFailure(device);
    else if (!skipLockout) guesses.recordFailure(guessKey);

    let matches = false;
    try {
      if (user?.passwordHash && user.disabledAt === null) {
        matches = await verifyPassword(user.passwordHash, password);
      } else {
        await spendVerifyTime(password);
      }
    } finally {
      passwordChecks.leave();
    }
    if (!user?.passwordHash || !matches) throw loginFailed();
    const verifiedHash = user.passwordHash;

    // A new token at every sign-in, so one planted before signing in is worthless after.
    await startSession(c, user, verifiedHash);
    const previous = getCookie(c, sessionCookie);
    if (previous) await deleteSession(orm, previous);

    loginAttemptsPerAddress.refund(addressKey);
    loginAttemptsPerAccount.refund(accountKey);
    if (network) loginAttemptsPerNetwork.refund(network);
    guesses.reset(guessKey);

    if (needsRehash(verifiedHash)) {
      await upgradePasswordHash(orm, user.id, verifiedHash, await hashPassword(password));
    }
    await touchLastSeen(orm, user.id, now());
    return c.json({ user: publicUser(user) });
  });

  app.post("/logout", async (c) => {
    const token = getCookie(c, sessionCookie);
    if (token) await deleteSession(orm, token);
    deleteCookie(c, sessionCookie, cookieBase);
    return c.body(null, 204);
  });

  app.post("/logout-all", async (c) => {
    const user = await requireUser(c);
    await deleteUserSessions(orm, user.id);
    deleteCookie(c, sessionCookie, cookieBase);
    return c.body(null, 204);
  });

  app.get("/me", async (c) => {
    const user = await requireUser(c);
    const site = await getSetting(orm, "site");
    const setup = await getSetting(orm, "setup");
    return c.json({
      user: publicUser(user),
      site: { name: site?.name ?? "", tagline: site?.tagline ?? "" },
      starter: setup?.starter ?? null,
      siteIsPublic: options.isPublic,
    });
  });

  return app;
}
