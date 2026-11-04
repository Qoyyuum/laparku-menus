CREATE TABLE `product_lookup_cache` (
	`code` text PRIMARY KEY NOT NULL,
	`merged_payload` text NOT NULL,
	`sources` text NOT NULL,
	`found` integer NOT NULL,
	`fetched_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `provider_budget` (
	`provider` text NOT NULL,
	`day` text NOT NULL,
	`calls` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`provider`, `day`)
);
--> statement-breakpoint
ALTER TABLE `submissions` ADD `scan_barcode` text;
--> statement-breakpoint
ALTER TABLE `submissions` ADD `publish_mode` text;
--> statement-breakpoint
ALTER TABLE `food_items` ADD `pending_verification` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `food_items` ADD `barcode_source` text;
