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
CREATE INDEX `venue_revisions_submission_idx` ON `venue_revisions` (`submission_id`);--> statement-breakpoint

-- Task 3 (freshness): `venues.last_verified_at` is set on every approved
-- publish and on each positive verify vote; NULL = never verified (v1-era
-- venues). `verifications` records "is this menu still current?" votes —
-- one row per user per venue per UTC day, enforced by the UNIQUE expression
-- index below on date(created_at) (created_at is epoch-ms, hence /1000).
-- Both the expression index and the plain-text user_id (no FK into the
-- untracked "user" table) follow this file's hand-folded convention.
ALTER TABLE `venues` ADD `last_verified_at` integer;--> statement-breakpoint
CREATE TABLE `verifications` (
	`id` text PRIMARY KEY NOT NULL,
	`venue_id` text NOT NULL,
	`user_id` text NOT NULL,
	`accurate` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`venue_id`) REFERENCES `venues`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
CREATE INDEX `verifications_venue_idx` ON `verifications` (`venue_id`);--> statement-breakpoint
CREATE INDEX `verifications_user_idx` ON `verifications` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `verifications_daily_idx` ON `verifications` (`venue_id`, `user_id`, date(`created_at` / 1000, 'unixepoch'));--> statement-breakpoint

-- Task 4 (check-ins): `venues.last_checkin_at` bumps on every check-in; the
-- admin staleness list reads NULL or older-than-STALE_MONTHS as a
-- "possibly closed" hint for reviewers (never an auto status change).
-- `check_ins` records "I ate here" visits with optional device geo and an
-- optional `menu_accurate` answer that also writes a verifications row
-- (Task 3 semantics). One check-in per user per venue per UTC day is
-- enforced by the UNIQUE expression index below — same hand-folded
-- convention as verifications_daily_idx — and the route counts rows to
-- return 429 rather than rely on the constraint.
ALTER TABLE `venues` ADD `last_checkin_at` integer;--> statement-breakpoint
CREATE TABLE `check_ins` (
	`id` text PRIMARY KEY NOT NULL,
	`venue_id` text NOT NULL,
	`user_id` text NOT NULL,
	`geo_lat` real,
	`geo_lng` real,
	`menu_accurate` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`venue_id`) REFERENCES `venues`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
CREATE INDEX `check_ins_venue_idx` ON `check_ins` (`venue_id`);--> statement-breakpoint
CREATE INDEX `check_ins_user_idx` ON `check_ins` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `check_ins_daily_idx` ON `check_ins` (`venue_id`, `user_id`, date(`created_at` / 1000, 'unixepoch'));--> statement-breakpoint

-- Task 5 (leaderboards): the opt-in display fields live on better-auth's
-- `user` table — added here by hand since the auth tables stay outside
-- drizzle's tracked schema (same convention as the hand-folded FKs and
-- expression indexes above; they are absent from meta/0002_snapshot.json on
-- purpose). `display_name` is what leaderboard rows render;
-- `show_on_leaderboard` is the opt-in (default false → rows render
-- "Anonymous"); `show_credit` opts into "contributed by" attribution on
-- venue/item responses (Task 7's rewards surface). `user` has no updated_at
-- trigger — PATCH /api/me bumps "updatedAt" itself.
ALTER TABLE "user" ADD `display_name` text;--> statement-breakpoint
ALTER TABLE "user" ADD `show_on_leaderboard` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD `show_credit` integer DEFAULT false NOT NULL;
