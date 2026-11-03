CREATE TABLE `food_items` (
	`id` text PRIMARY KEY NOT NULL,
	`venue_id` text NOT NULL,
	`item_type` text NOT NULL,
	`name` text NOT NULL,
	`name_ms` text,
	`description` text,
	`price_bnd` real,
	`category` text,
	`tags` text NOT NULL,
	`nutrition_estimate` text,
	`brand` text,
	`barcode` text,
	`package_size` text,
	`off_barcode` text,
	`source_submission_id` text,
	`superseded_by` text,
	`status` text DEFAULT 'published' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`venue_id`) REFERENCES `venues`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_submission_id`) REFERENCES `submissions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `food_items_venue_idx` ON `food_items` (`venue_id`);--> statement-breakpoint
CREATE INDEX `food_items_superseded_idx` ON `food_items` (`superseded_by`);--> statement-breakpoint
CREATE INDEX `food_items_source_submission_idx` ON `food_items` (`source_submission_id`);--> statement-breakpoint
CREATE TABLE `item_flags` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`reason` text NOT NULL,
	`reporter_contact` text,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `food_items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `item_flags_item_idx` ON `item_flags` (`item_id`);--> statement-breakpoint
CREATE INDEX `item_flags_status_idx` ON `item_flags` (`status`);--> statement-breakpoint
CREATE TABLE `submissions` (
	`id` text PRIMARY KEY NOT NULL,
	`submitter_id` text,
	`contact` text,
	`source_type` text NOT NULL,
	`provenance` text NOT NULL,
	`image_keys` text NOT NULL,
	`raw_extraction` text,
	`confidence` real,
	`phash` text,
	`sha256` text,
	`auto_flags` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`rejection_reason` text,
	`reviewer_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`submitter_id`) REFERENCES `submitters`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `submissions_status_idx` ON `submissions` (`status`);--> statement-breakpoint
CREATE INDEX `submissions_sha256_idx` ON `submissions` (`sha256`);--> statement-breakpoint
CREATE INDEX `submissions_phash_idx` ON `submissions` (`phash`);--> statement-breakpoint
CREATE INDEX `submissions_submitter_idx` ON `submissions` (`submitter_id`);--> statement-breakpoint
CREATE TABLE `submitters` (
	`id` text PRIMARY KEY NOT NULL,
	`auth_user_id` text,
	`identifier` text,
	`submissions_count` integer DEFAULT 0 NOT NULL,
	`approved_count` integer DEFAULT 0 NOT NULL,
	`rejected_count` integer DEFAULT 0 NOT NULL,
	`trust_tier` text DEFAULT 'new' NOT NULL,
	`blocked` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `submitters_auth_user_idx` ON `submitters` (`auth_user_id`);--> statement-breakpoint
CREATE INDEX `submitters_identifier_idx` ON `submitters` (`identifier`);--> statement-breakpoint
CREATE TABLE `venues` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`name_ms` text,
	`type` text NOT NULL,
	`area` text NOT NULL,
	`address` text,
	`geo` text,
	`instagram` text,
	`website` text,
	`halal_status` text DEFAULT 'unknown' NOT NULL,
	`verification` text DEFAULT 'unverified' NOT NULL,
	`status` text DEFAULT 'published' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
