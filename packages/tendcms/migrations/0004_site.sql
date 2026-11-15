CREATE TABLE `entry_tags` (
	`entry_id` text NOT NULL,
	`tag_id` text NOT NULL,
	PRIMARY KEY(`entry_id`, `tag_id`),
	FOREIGN KEY (`entry_id`) REFERENCES `entries`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `entry_tags_by_tag` ON `entry_tags` (`tag_id`);--> statement-breakpoint
CREATE TABLE `media` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`original_name` text NOT NULL,
	`mime` text NOT NULL,
	`ext` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`width` integer,
	`height` integer,
	`sha256` text NOT NULL,
	`variants` text NOT NULL,
	`alt` text,
	`decorative` integer DEFAULT 0 NOT NULL,
	`caption` text,
	`credit` text,
	`focal_x` real DEFAULT 0.5 NOT NULL,
	`focal_y` real DEFAULT 0.5 NOT NULL,
	`dominant_color` text,
	`uploaded_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`trashed_at` integer,
	FOREIGN KEY (`uploaded_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "media_kind_check" CHECK("media"."kind" IN ('image', 'file'))
);
--> statement-breakpoint
CREATE INDEX `media_newest` ON `media` (`created_at`);--> statement-breakpoint
CREATE INDEX `media_trashed` ON `media` (`trashed_at`);--> statement-breakpoint
CREATE TABLE `redirects` (
	`from_path` text PRIMARY KEY NOT NULL,
	`to_path` text NOT NULL,
	`status` integer DEFAULT 301 NOT NULL,
	`source` text NOT NULL,
	`created_at` integer NOT NULL,
	`hits` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "redirects_source_check" CHECK("redirects"."source" IN ('auto', 'manual', 'import'))
);
--> statement-breakpoint
CREATE INDEX `redirects_to` ON `redirects` (`to_path`);--> statement-breakpoint
CREATE TABLE `settings_history` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`value` text,
	`created_at` integer NOT NULL,
	`user_id` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `settings_history_by_key` ON `settings_history` (`key`,`created_at`);--> statement-breakpoint
CREATE TABLE `tags` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`description` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tags_slug_unique` ON `tags` (`slug`);