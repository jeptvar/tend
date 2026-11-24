import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.ts";

export type SqliteDatabase = Database.Database;

/** Opens tend.db with the pragmas every connection needs (PLAN.md §11). */
export function openDatabase(path: string): SqliteDatabase {
  const db = new Database(path);
  try {
    // The first to read the file, so this is what fails on one that's damaged.
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("busy_timeout = 5000");
    db.pragma("foreign_keys = ON");
    db.pragma("temp_store = MEMORY");
    db.pragma("trusted_schema = OFF");
  } catch (error) {
    // Left open, Windows wouldn't let a backup be put in its place.
    db.close();
    throw error;
  }
  // SQLite only ignores case for A to Z. Searching for "école" should find "École", and
  // "ecole" should too, as people type it on any keyboard.
  db.function("tend_fold", { deterministic: true }, (value: unknown) =>
    typeof value === "string" ? foldForSearch(value) : value,
  );
  return db;
}

/** Lower case, with accents taken off, for comparing what people type with what's stored. */
export function foldForSearch(text: string): string {
  return text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

export function createOrm(db: SqliteDatabase) {
  return drizzle({ client: db, schema });
}

export type Orm = ReturnType<typeof createOrm>;
