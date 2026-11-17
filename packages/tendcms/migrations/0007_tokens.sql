CREATE TABLE `tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`email` text COLLATE NOCASE,
	`role` text,
	`user_id` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`expires_at` integer,
	`used_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "tokens_kind_check" CHECK("tokens"."kind" IN ('setup', 'invite', 'reset', 'recovery', 'preview')),
	CONSTRAINT "tokens_role_check" CHECK("tokens"."role" IS NULL OR "tokens"."role" IN ('admin', 'editor', 'writer'))
);
--> statement-breakpoint
CREATE INDEX `tokens_by_user` ON `tokens` (`user_id`,`kind`);--> statement-breakpoint
CREATE INDEX `tokens_by_email` ON `tokens` (`email`,`kind`);