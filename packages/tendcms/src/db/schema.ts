import { sql } from "drizzle-orm";
import {
  check,
  customType,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// Emails compare case-insensitively everywhere, including the UNIQUE constraint.
const textNoCase = customType<{ data: string }>({ dataType: () => "text COLLATE NOCASE" });

/** Keys: schema_version, app_version_last_run, min_app_version, render_version. */
export const schemaMeta = sqliteTable("schema_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: textNoCase("email").notNull().unique(),
    name: text("name").notNull(),
    role: text("role", { enum: ["admin", "editor", "writer"] }).notNull(),
    isOwner: integer("is_owner").notNull().default(0),
    passwordHash: text("password_hash"),
    totpSecretEnc: text("totp_secret_enc"),
    locale: text("locale").notNull().default("en"),
    createdAt: integer("created_at").notNull(),
    lastSeenAt: integer("last_seen_at"),
    disabledAt: integer("disabled_at"),
  },
  (t) => [
    check("users_role_check", sql`${t.role} IN ('admin', 'editor', 'writer')`),
    uniqueIndex("users_single_owner").on(t.isOwner).where(sql`${t.isOwner} = 1`),
  ],
);
