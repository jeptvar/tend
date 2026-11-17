CREATE TABLE `retired_originals` (
	`media_id` text NOT NULL,
	`hash` text NOT NULL,
	`ext` text NOT NULL,
	`retired_at` integer NOT NULL,
	PRIMARY KEY(`media_id`, `hash`)
);
