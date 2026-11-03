-- Phase 2 schema changes, accumulated across phase-2 tasks (one file, per
-- the phase-2 plan). drizzle-kit generated the ALTER/CREATE below; the FK
-- to "user"("id") is folded in by hand — "user" is a better-auth table kept
-- outside drizzle's tracked schema (same convention as 0001_auth.sql).
-- `user_id` is nullable so v1-era anonymous rows remain valid; the routes
-- set it on every new insert.
ALTER TABLE `submissions` ADD `user_id` text REFERENCES "user"("id");--> statement-breakpoint
CREATE INDEX `submissions_user_id_idx` ON `submissions` (`user_id`);--> statement-breakpoint

-- Task 2 (revisions + merge publishing): `is_current` becomes the live flag
-- the public API reads (v1 used `superseded_by IS NULL` as the proxy);
-- `venue_revisions` is the audit spine recording who published which
-- submission onto a venue and how (replace | merge). is_current defaults to
-- true — a plain insert is live, matching v1 "published + unsuperseded"
-- semantics — then the UPDATE fixes up rows that were already dead.
ALTER TABLE `food_items` ADD `is_current` integer DEFAULT true NOT NULL;--> statement-breakpoint
UPDATE `food_items` SET `is_current` = false WHERE `status` != 'published' OR `superseded_by` IS NOT NULL;--> statement-breakpoint
CREATE TABLE `venue_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`venue_id` text NOT NULL,
	`submission_id` text,
	`reviewer_id` text NOT NULL,
	`mode` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`venue_id`) REFERENCES `venues`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`submission_id`) REFERENCES `submissions`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
CREATE INDEX `venue_revisions_venue_idx` ON `venue_revisions` (`venue_id`);--> statement-breakpoint
CREATE INDEX `venue_revisions_submission_idx` ON `venue_revisions` (`submission_id`);
