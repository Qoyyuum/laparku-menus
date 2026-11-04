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
