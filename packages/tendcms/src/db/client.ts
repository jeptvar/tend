import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.ts";

export type SqliteDatabase = Database.Database;

/** Opens tend.db with the pragmas every connection needs (PLAN.md §11). */
export function openDatabase(path: string): SqliteDatabase {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  db.pragma("temp_store = MEMORY");
  db.pragma("trusted_schema = OFF");
  return db;
}

export function createOrm(db: SqliteDatabase) {
  return drizzle({ client: db, schema });
}
