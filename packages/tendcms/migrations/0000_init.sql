CREATE TABLE `schema_meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text COLLATE NOCASE NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`is_owner` integer DEFAULT 0 NOT NULL,
	`password_hash` text,
	`totp_secret_enc` text,
	`locale` text DEFAULT 'en' NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer,
	`disabled_at` integer,
	CONSTRAINT "users_role_check" CHECK("users"."role" IN ('admin', 'editor', 'writer'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_single_owner` ON `users` (`is_owner`) WHERE "users"."is_owner" = 1;