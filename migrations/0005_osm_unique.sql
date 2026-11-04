ALTER TABLE `venues` ADD `created_by` text;--> statement-breakpoint
CREATE UNIQUE INDEX `venues_osm_ref_idx` ON `venues` (`osm_ref`);