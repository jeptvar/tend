import { PlainError } from "../plain-error.ts";

/** Whether this is SQLite saying that a file isn't a database, or isn't a whole one. */
export function isDamage(error: unknown): boolean {
  return /^SQLITE_(NOTADB|CORRUPT)/.test(String((error as { code?: unknown }).code));
}

/** What to say about a site whose database is damaged. */
export function damagedDatabase(why: string): PlainError {
  return new PlainError(
    `The site's database is damaged (${why}). Close Tend if it's running, and put the site back from a backup: tendcms restore <file>`,
  );
}
