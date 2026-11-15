import type { RunResult } from "better-sqlite3";
import { asc, eq, sql } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { ApiError } from "../api/errors.ts";
import type { Orm } from "../db/client.ts";
import type * as schema from "../db/schema.ts";
import { redirects } from "../db/schema.ts";

export type Redirect = typeof redirects.$inferSelect;
type Db = BaseSQLiteDatabase<"sync", RunResult, typeof schema>;

const PATH_LIMIT = 500;
const URL_LIMIT = 2048;
/** Far more than any real chain: it only stops a broken table from looping forever. */
const CHAIN_LIMIT = 50;
const HOST = /^(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?$/i;
/** Endings of file names, which "menu.html" has but "oldsite.com" doesn't. */
const FILE_ENDINGS = new Set([
  "html",
  "htm",
  "shtml",
  "php",
  "asp",
  "aspx",
  "jsp",
  "cgi",
  "pdf",
  "xml",
  "txt",
  "json",
]);

/** An address someone typed without https://, like "oldsite.com/menu", not "menu.html". */
function hasBareHost(typed: string): boolean {
  const host = typed.split(/[/?#]/)[0] ?? "";
  if (!HOST.test(host)) return false;
  const ending = host.replace(/:\d+$/, "").split(".").pop()?.toLowerCase() ?? "";
  return !FILE_ENDINGS.has(ending) && !/^\d+$/.test(ending);
}
// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing them is the point
const UNSAFE = /[\u0000- \u007f<>"`\\]/;

/**
 * An old address that now leads to a new one (PLAN.md §9). Anything that led to the old
 * address now leads to the new one in one step, so there are no chains, and a redirect
 * that would point at itself is dropped.
 */
export function addRedirect(
  db: Db,
  input: { from: string; to: string; source: Redirect["source"]; now: number },
): void {
  const { from, to } = input;
  if (sameAddress(from, to)) return;
  db.update(redirects).set({ toPath: to }).where(eq(redirects.toPath, from)).run();
  db.insert(redirects)
    .values({ fromPath: from, toPath: to, source: input.source, createdAt: input.now })
    .onConflictDoUpdate({
      target: redirects.fromPath,
      set: { toPath: to, source: input.source, createdAt: input.now, hits: 0 },
    })
    .run();
  // A to B, then B to A, would otherwise leave A pointing at itself.
  db.delete(redirects).where(sql`lower(${redirects.fromPath}) = lower(${redirects.toPath})`).run();
}

/** Something was published here, and live pages always win over redirects. */
export function clearRedirectFrom(db: Db, path: string): void {
  db.delete(redirects).where(eq(redirects.fromPath, path)).run();
}

/** Addresses are matched ignoring case, because old sites often had capitals in theirs. */
function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Where an address that isn't a page leads, counting the visit. `sent` is the path as it
 * arrived, still encoded: it's decoded the same way old addresses are when they're saved,
 * then tried in lower case too, so every way of writing it matches.
 */
export async function followRedirect(orm: Orm, sent: string): Promise<string | undefined> {
  const path = decoded(sent);
  for (const candidate of new Set([path, path.toLowerCase()])) {
    const found = orm
      .update(redirects)
      .set({ hits: sql`${redirects.hits} + 1` })
      .where(eq(redirects.fromPath, candidate))
      .returning({ to: redirects.toPath })
      .get();
    if (found) return found.to;
  }
  return undefined;
}

export async function listRedirects(orm: Orm): Promise<Redirect[]> {
  return orm.select().from(redirects).orderBy(asc(redirects.fromPath)).all();
}

function refuse(field: "from" | "to", message: string, fix: string): ApiError {
  return new ApiError(400, "needs_fixing", message, { field, fix });
}

function decoded(path: string): string {
  try {
    return decodeURI(path);
  } catch {
    // Not valid percent-encoding, so it can only ever arrive as written.
    return path;
  }
}

/** One slash between parts, none at the end, and nothing that isn't part of the path. */
function tidyPath(path: string): string {
  let tidy = path.startsWith("/") ? path : `/${path}`;
  tidy = tidy.replace(/\/{2,}/g, "/");
  return tidy.length > 1 ? tidy.replace(/\/+$/, "") : tidy;
}

/** A whole address as typed, with https:// added when it was left out. */
function asUrl(typed: string): URL | undefined {
  const withScheme = hasBareHost(typed) ? `https://${typed}` : typed;
  if (!/^https?:\/\//i.test(withScheme)) return undefined;
  try {
    return new URL(withScheme);
  } catch {
    return undefined;
  }
}

/**
 * The old address, stored the way the site compares addresses: a decoded path with
 * nothing after it. A whole address from an old website gives just its path.
 */
export function cleanFrom(typed: string): string {
  const text = typed.trim();
  if (text === "") {
    throw refuse("from", "Type the old address.", "For example /old-page.");
  }
  if (UNSAFE.test(text.replace(/ /g, ""))) {
    throw refuse(
      "from",
      "That address has characters addresses can't have.",
      "Type it like /old-page.",
    );
  }
  const url = asUrl(text);
  if (/^[a-z][a-z0-9+.-]*:/i.test(text) && !url) {
    throw refuse("from", "That isn't an address on a website.", "Type it like /old-page.");
  }
  const raw = url ? url.pathname : text;
  if ((url && (url.search || url.hash)) || /[?#]/.test(raw)) {
    throw refuse(
      "from",
      "Addresses with ? or # in them can't be redirected.",
      "Use the part before the ? or #, if that was a page of its own.",
    );
  }
  const path = tidyPath(decoded(raw));
  if (path.length > PATH_LIMIT) {
    throw refuse(
      "from",
      `That address is too long: use ${PATH_LIMIT} characters or fewer.`,
      "Use only the page's own address, like /old-page.",
    );
  }
  if (UNSAFE.test(path.replace(/ /g, ""))) {
    throw refuse(
      "from",
      "That address has characters addresses can't have.",
      "Type it like /old-page.",
    );
  }
  if (path === "/") {
    throw refuse(
      "from",
      "The homepage can't lead somewhere else.",
      "Use the old page's own address, like /old-page.",
    );
  }
  return path;
}

/**
 * Where it goes: a path on this site, or a whole address elsewhere. Stored encoded, as a
 * browser can follow it. An address on this site itself is kept as just its path.
 */
export function cleanTo(typed: string, ownHosts: readonly string[] = []): string {
  const text = typed.trim();
  if (text === "") {
    throw refuse("to", "Type where it should go.", "For example /about, or https://example.com.");
  }
  if (UNSAFE.test(text.replace(/ /g, ""))) {
    throw refuse("to", "That address has characters addresses can't have.", "Type it like /about.");
  }
  const url = asUrl(text);
  if (/^[a-z][a-z0-9+.-]*:/i.test(text) && !url) {
    throw refuse(
      "to",
      "Redirects can only go to web pages.",
      "Use an address that starts with https://, or one of your pages like /about.",
    );
  }
  if (url && !ownHosts.includes(url.host.toLowerCase())) {
    if (url.href.length > URL_LIMIT) {
      throw refuse(
        "to",
        "That address is too long.",
        "Use a shorter one, without anything after a ?.",
      );
    }
    return url.href;
  }
  const path = url ? `${url.pathname}${url.search}` : text;
  if (UNSAFE.test(decoded(path).replace(/ /g, ""))) {
    throw refuse("to", "That address has characters addresses can't have.", "Type it like /about.");
  }
  const [route = "", query] = path.split(/\?(.*)/s, 2);
  const tidy = tidyPath(decoded(route.split("#")[0] ?? ""));
  const encoded = `${encodeURI(tidy)}${query ? `?${query}` : ""}`;
  if (encoded.length > URL_LIMIT) {
    throw refuse(
      "to",
      "That address is too long.",
      "Use a shorter one, without anything after a ?.",
    );
  }
  return encoded;
}

/** Where an address finally ends up, following any redirects from it. */
function finalTarget(db: Db, to: string, from: string): string {
  let target = to;
  const seen = new Set<string>();
  for (let hop = 0; hop < CHAIN_LIMIT; hop++) {
    const path = decoded(target.split("?")[0] ?? target);
    if (sameAddress(path, from)) {
      throw refuse(
        "to",
        "That would lead back to the old address, so visitors would go round in circles.",
        "Choose a different address for Goes to.",
      );
    }
    if (seen.has(path.toLowerCase())) break;
    seen.add(path.toLowerCase());
    const next = db
      .select({ to: redirects.toPath })
      .from(redirects)
      .where(sql`lower(${redirects.fromPath}) = lower(${path})`)
      .get();
    if (!next) return target;
    target = next.to;
  }
  return target;
}

/**
 * A redirect added by hand. It never removes another one: only publishing something at an
 * address does that. If where it goes is itself redirected, it goes straight to the end.
 */
export async function addManualRedirect(
  orm: Orm,
  input: { from: string; to: string; now: number },
): Promise<void> {
  orm.transaction(
    (tx) => {
      const to = finalTarget(tx, input.to, input.from);
      addRedirect(tx, { from: input.from, to, source: "manual", now: input.now });
    },
    { behavior: "immediate" },
  );
}

export async function removeRedirect(orm: Orm, from: string): Promise<void> {
  orm.delete(redirects).where(eq(redirects.fromPath, from)).run();
}
