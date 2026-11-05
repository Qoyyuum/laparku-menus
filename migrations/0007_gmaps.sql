-- gmaps_link import: venues.google_place_id is the Google-side dedup key,
-- same role as osm_ref (unique so a same-place re-create races resolve to
-- one row; NULLs stay distinct so non-Maps venues are unaffected).
ALTER TABLE `venues` ADD `google_place_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `venues_google_place_id_idx` ON `venues` (`google_place_id`);
