CREATE TABLE `entries` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`slug` text DEFAULT '' NOT NULL,
	`live_slug` text,
	`is_home` integer DEFAULT 0 NOT NULL,
	`data` text NOT NULL,
	`dirty` integer DEFAULT 0 NOT NULL,
	`rev` integer DEFAULT 1 NOT NULL,
	`published_rev_id` text,
	`publish_at` integer,
	`first_published_at` integer,
	`review_requested_at` integer,
	`is_example` integer DEFAULT 0 NOT NULL,
	`author_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`trashed_at` integer,
	FOREIGN KEY (`published_rev_id`) REFERENCES `revisions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "entries_status_check" CHECK("entries"."status" IN ('draft', 'scheduled', 'published'))
);
--> statement-breakpoint
CREATE INDEX `entries_listing` ON `entries` (`type`,`status`,`first_published_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `entries_live_address` ON `entries` (`type`,`live_slug`) WHERE "entries"."live_slug" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `entries_single_home` ON `entries` (`is_home`) WHERE "entries"."is_home" = 1;--> statement-breakpoint
CREATE TABLE `revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`entry_id` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`slug` text NOT NULL,
	`data` text NOT NULL,
	`html` text,
	`text` text,
	`author_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`entry_id`) REFERENCES `entries`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "revisions_kind_check" CHECK("revisions"."kind" IN ('autosave', 'publish', 'restore', 'before_discard', 'conflict', 'import'))
);
--> statement-breakpoint
CREATE INDEX `revisions_by_entry` ON `revisions` (`entry_id`,`created_at`);