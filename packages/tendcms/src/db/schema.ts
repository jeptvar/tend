import { sql } from "drizzle-orm";
import {
  check,
  customType,
  index,
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
    /** When `tendcms reset-password` last ran, which lifts a lockout for a while. */
    passwordResetAt: integer("password_reset_at"),
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

export const sessions = sqliteTable(
  "sessions",
  {
    /** SHA-256 of the token. The token itself is only ever in the person's cookie. */
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull(),
    lastUsedAt: integer("last_used_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    userAgent: text("user_agent"),
    /** Truncated on purpose: /24 for IPv4, /64 for IPv6. */
    ipPrefix: text("ip_prefix"),
  },
  (t) => [index("sessions_user_id").on(t.userId)],
);

/** Keys so far: site, setup. See PLAN.md §8 for the rest. */
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).notNull(),
  updatedAt: integer("updated_at").notNull(),
  updatedBy: text("updated_by"),
});
