CREATE TABLE `refs` (
	`entry_id` text NOT NULL,
	`scope` text NOT NULL,
	`kind` text NOT NULL,
	`ref_id` text NOT NULL,
	PRIMARY KEY(`entry_id`, `scope`, `kind`, `ref_id`),
	FOREIGN KEY (`entry_id`) REFERENCES `entries`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "refs_scope_check" CHECK("refs"."scope" IN ('working', 'live')),
	CONSTRAINT "refs_kind_check" CHECK("refs"."kind" IN ('media', 'entry'))
);
--> statement-breakpoint
CREATE INDEX `refs_by_target` ON `refs` (`kind`,`ref_id`);--> statement-breakpoint
ALTER TABLE `entries` ADD `updated_by` text REFERENCES users(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `entries` ADD `edit_session` text;--> statement-breakpoint
ALTER TABLE `entries` ADD `edit_seq` integer;--> statement-breakpoint
CREATE INDEX `entries_trashed` ON `entries` (`trashed_at`);