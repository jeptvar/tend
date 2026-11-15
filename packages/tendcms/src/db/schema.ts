import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  check,
  customType,
  index,
  integer,
  primaryKey,
  real,
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

export const entries = sqliteTable(
  "entries",
  {
    id: text("id").primaryKey(),
    /** "post" or "page". The application checks this, because Collections add more at 1.1. */
    type: text("type").notNull(),
    status: text("status", { enum: ["draft", "scheduled", "published"] })
      .notNull()
      .default("draft"),
    title: text("title").notNull().default(""),
    /** The working address, which goes live at the next publish. */
    slug: text("slug").notNull().default(""),
    /** The address visitors can use now. Null when it isn't on the site. */
    liveSlug: text("live_slug"),
    isHome: integer("is_home").notNull().default(0),
    /** The working copy: see EntryData in content/doc.ts. */
    data: text("data", { mode: "json" }).notNull(),
    /** 1 when the working copy has changes that aren't on the site yet. */
    dirty: integer("dirty").notNull().default(0),
    /** Goes up with every save, so two people can't silently overwrite each other. */
    rev: integer("rev").notNull().default(1),
    publishedRevId: text("published_rev_id").references((): AnySQLiteColumn => revisions.id, {
      onDelete: "set null",
    }),
    publishAt: integer("publish_at"),
    firstPublishedAt: integer("first_published_at"),
    reviewRequestedAt: integer("review_requested_at"),
    isExample: integer("is_example").notNull().default(0),
    authorId: text("author_id").references(() => users.id, { onDelete: "set null" }),
    /** Who saved it last, so a conflict can say who changed it. */
    updatedBy: text("updated_by").references(() => users.id, { onDelete: "set null" }),
    /** The editor window that saved it last, so its own earlier saves are never a conflict. */
    editSession: text("edit_session"),
    /** That window's count of what it's sent, so a late, older request can't undo a newer one. */
    editSeq: integer("edit_seq"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    trashedAt: integer("trashed_at"),
  },
  (t) => [
    check("entries_status_check", sql`${t.status} IN ('draft', 'scheduled', 'published')`),
    index("entries_listing").on(t.type, t.status, t.firstPublishedAt),
    uniqueIndex("entries_live_address")
      .on(t.type, t.liveSlug)
      .where(sql`${t.liveSlug} IS NOT NULL`),
    uniqueIndex("entries_single_home").on(t.isHome).where(sql`${t.isHome} = 1`),
    index("entries_trashed").on(t.trashedAt),
  ],
);

export const revisions = sqliteTable(
  "revisions",
  {
    id: text("id").primaryKey(),
    entryId: text("entry_id")
      .notNull()
      .references((): AnySQLiteColumn => entries.id, { onDelete: "cascade" }),
    kind: text("kind", {
      enum: ["autosave", "publish", "restore", "before_discard", "conflict", "import"],
    }).notNull(),
    title: text("title").notNull(),
    slug: text("slug").notNull(),
    data: text("data", { mode: "json" }).notNull(),
    /** Publish revisions only: what visitors see. */
    html: text("html"),
    text: text("text"),
    authorId: text("author_id"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    check(
      "revisions_kind_check",
      sql`${t.kind} IN ('autosave', 'publish', 'restore', 'before_discard', 'conflict', 'import')`,
    ),
    index("revisions_by_entry").on(t.entryId, t.createdAt),
  ],
);

/** What each working copy and live version links to. See PLAN.md §8. */
export const refs = sqliteTable(
  "refs",
  {
    entryId: text("entry_id")
      .notNull()
      .references(() => entries.id, { onDelete: "cascade" }),
    scope: text("scope", { enum: ["working", "live"] }).notNull(),
    kind: text("kind", { enum: ["media", "entry"] }).notNull(),
    refId: text("ref_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.entryId, t.scope, t.kind, t.refId] }),
    check("refs_scope_check", sql`${t.scope} IN ('working', 'live')`),
    check("refs_kind_check", sql`${t.kind} IN ('media', 'entry')`),
    index("refs_by_target").on(t.kind, t.refId),
  ],
);

/**
 * Photos and files (PLAN.md §8). The re-encoded original is kept in the uploads folder, and
 * the sizes visitors get are made from it once, when it's uploaded.
 */
export const media = sqliteTable(
  "media",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: ["image", "file"] }).notNull(),
    originalName: text("original_name").notNull(),
    mime: text("mime").notNull(),
    ext: text("ext").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    width: integer("width"),
    height: integer("height"),
    sha256: text("sha256").notNull(),
    /** The widths made for visitors, smallest first. Empty for files. */
    variants: text("variants", { mode: "json" }).notNull(),
    alt: text("alt"),
    decorative: integer("decorative").notNull().default(0),
    caption: text("caption"),
    credit: text("credit"),
    focalX: real("focal_x").notNull().default(0.5),
    focalY: real("focal_y").notNull().default(0.5),
    dominantColor: text("dominant_color"),
    uploadedBy: text("uploaded_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    trashedAt: integer("trashed_at"),
  },
  (t) => [
    check("media_kind_check", sql`${t.kind} IN ('image', 'file')`),
    index("media_newest").on(t.createdAt),
    index("media_trashed").on(t.trashedAt),
  ],
);

/** Earlier values of each setting, for Undo. The last 20 per key are kept. */
export const settingsHistory = sqliteTable(
  "settings_history",
  {
    id: text("id").primaryKey(),
    key: text("key").notNull(),
    /** Null: it had never been set, so undoing goes back to the default. */
    value: text("value", { mode: "json" }),
    createdAt: integer("created_at").notNull(),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [index("settings_history_by_key").on(t.key, t.createdAt)],
);

/** Old addresses that lead to new ones (PLAN.md §9). */
export const redirects = sqliteTable(
  "redirects",
  {
    fromPath: text("from_path").primaryKey(),
    toPath: text("to_path").notNull(),
    status: integer("status").notNull().default(301),
    source: text("source", { enum: ["auto", "manual", "import"] }).notNull(),
    createdAt: integer("created_at").notNull(),
    hits: integer("hits").notNull().default(0),
  },
  (t) => [
    check("redirects_source_check", sql`${t.source} IN ('auto', 'manual', 'import')`),
    index("redirects_to").on(t.toPath),
  ],
);

export const tags = sqliteTable("tags", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  description: text("description"),
  createdAt: integer("created_at").notNull(),
});

/** The tags on what's live, rewritten at each publish. The working copy keeps its own. */
export const entryTags = sqliteTable(
  "entry_tags",
  {
    entryId: text("entry_id")
      .notNull()
      .references(() => entries.id, { onDelete: "cascade" }),
    tagId: text("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.entryId, t.tagId] }), index("entry_tags_by_tag").on(t.tagId)],
);
