-- Phase 2 schema changes, accumulated across phase-2 tasks (one file, per
-- the phase-2 plan). drizzle-kit generated the ALTER/CREATE below; the FK
-- to "user"("id") is folded in by hand — "user" is a better-auth table kept
-- outside drizzle's tracked schema (same convention as 0001_auth.sql).
-- `user_id` is nullable so v1-era anonymous rows remain valid; the routes
-- set it on every new insert.
ALTER TABLE `submissions` ADD `user_id` text REFERENCES "user"("id");--> statement-breakpoint
CREATE INDEX `submissions_user_id_idx` ON `submissions` (`user_id`);
