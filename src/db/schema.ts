import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// Machine estimate vs reviewer-verified nutrition (spec: `nutrition_estimate`).
export interface NutritionEstimate {
  status: "estimated" | "verified";
  calories_kcal?: number;
  protein_g?: number;
  carbs_g?: number;
  fat_g?: number;
  source?: string;
  [key: string]: unknown;
}

// Shape of the vision-model draft stored on `submissions.raw_extraction`
// (kept loose — the extraction pipeline owns the exact shape).
export interface RawExtraction {
  has_food_content?: boolean;
  confidence?: number;
  venue_guess?: { name: string; type?: string; area?: string } | null;
  items?: unknown[];
  suspicion?: string[];
  [key: string]: unknown;
}

export const VENUE_TYPES = ["restaurant", "stall", "supermarket", "grocer", "convenience"] as const;
export const AREAS = ["Brunei-Muara", "Tutong", "Belait", "Temburong"] as const;
export const HALAL_STATUSES = ["halal-certified", "muslim-owned", "non-halal", "unknown", "n-a"] as const;
export const VENUE_VERIFICATIONS = ["unverified", "verified", "claimed-by-owner"] as const;
export const ITEM_TYPES = ["dish", "product"] as const;
export const SOURCE_TYPES = ["menu_pdf", "menu_photo", "product_photo", "barcode", "url", "manual_entry"] as const;
export const SUBMISSION_STATUSES = [
  "pending",
  "pending_review",
  "auto_rejected",
  "rejected",
  "approved",
  // Scan-intake trusted path: items went live immediately (pending the
  // reviewer double-check) — no approval stage preceded the publish.
  "trusted_published",
] as const;
// How the submission's items reached the public menu: a reviewer decided
// ("reviewed") or the scan intake trusted-published them ("trusted").
export const PUBLISH_MODES = ["reviewed", "trusted"] as const;
export const REVISION_MODES = ["replace", "merge"] as const;
export const VENUE_REQUEST_STATUSES = ["open", "fulfilled"] as const;

const id = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());

const createdAt = () =>
  integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date());

const updatedAt = () =>
  integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdate(() => new Date());

export const venues = sqliteTable("venues", {
  id: id(),
  name: text("name").notNull(),
  name_ms: text("name_ms"),
  type: text("type", { enum: VENUE_TYPES }).notNull(),
  area: text("area", { enum: AREAS }).notNull(),
  address: text("address"),
  geo: text("geo", { mode: "json" }).$type<{ lat: number; lng: number }>(),
  instagram: text("instagram"),
  website: text("website"),
  halal_status: text("halal_status", { enum: HALAL_STATUSES }).notNull().default("unknown"),
  verification: text("verification", { enum: VENUE_VERIFICATIONS }).notNull().default("unverified"),
  status: text("status", { enum: ["published", "draft", "closed"] }).notNull().default("published"),
  // Freshness signal: bumped on every approved publish and on each positive
  // ("accurate") verify vote. NULL means never verified — v1-era venues and
  // direct seeds — which reads as fully stale.
  last_verified_at: integer("last_verified_at", { mode: "timestamp_ms" }),
  // Liveness signal: bumped on every check-in. NULL means never checked
  // into — read as "possibly closed" on the admin staleness list (a hint
  // for reviewers, never an automatic status change).
  last_checkin_at: integer("last_checkin_at", { mode: "timestamp_ms" }),
  // Coverage stub: a placeholder venue (name + area only) seeded manually
  // or by reviewers to mark "menu needed here". Stubs appear in the public
  // venue lists/search with `is_stub` on the payload; approving a
  // submission onto a stub clears the flag (see src/lib/publish.ts).
  is_stub: integer("is_stub", { mode: "boolean" }).notNull().default(false),
  // OpenStreetMap provenance for venues created from a Nominatim pick via
  // POST /api/venues — "<osm_type>/<osm_id>" (e.g. "node/123", "way/456").
  // Doubles as the dedup key: a second create for the same OSM object
  // returns the existing row instead of inserting a twin.
  osm_ref: text("osm_ref"),
  created_at: createdAt(),
  updated_at: updatedAt(),
});

export const submissions = sqliteTable(
  "submissions",
  {
    id: id(),
    submitter_id: text("submitter_id").references(() => submitters.id),
    // Better-auth user that filed the submission (session or verified API
    // key). Nullable: v1-era anonymous rows are grandfathered; every new
    // write sets it. The FK to "user".id lives in 0002_phase2.sql — the
    // auth tables stay outside drizzle's tracked schema (same convention
    // as reviewer_id below).
    user_id: text("user_id"),
    // Anonymous contact (email/phone). Required at the route level for
    // text-only (`manual_entry`) entries.
    contact: text("contact"),
    source_type: text("source_type", { enum: SOURCE_TYPES }).notNull(),
    // Declared provenance: IG handle, physical menu, PDF link, ...
    provenance: text("provenance").notNull(),
    // R2 object keys (`submissions/<id>/<n>`).
    image_keys: text("image_keys", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .$defaultFn(() => []),
    raw_extraction: text("raw_extraction", { mode: "json" }).$type<RawExtraction>(),
    confidence: real("confidence"),
    phash: text("phash"),
    sha256: text("sha256"),
    // e.g. generator_signature, venue_unverified, price_outlier,
    // extractor_suspicion, phash_dup, dup_sha256, no_food_content
    auto_flags: text("auto_flags", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .$defaultFn(() => []),
    status: text("status", { enum: SUBMISSION_STATUSES }).notNull().default("pending"),
    // Scan-intake provenance: the first/primary barcode of the batch
    // (digits — audit trail for scan submissions; NULL on every other
    // source). `publish_mode` records whether the items reached the menu
    // via a reviewer decision or the trusted-publish path.
    scan_barcode: text("scan_barcode"),
    publish_mode: text("publish_mode", { enum: PUBLISH_MODES }),
    rejection_reason: text("rejection_reason"),
    reviewer_id: text("reviewer_id"),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    index("submissions_status_idx").on(t.status),
    index("submissions_sha256_idx").on(t.sha256),
    index("submissions_phash_idx").on(t.phash),
    index("submissions_submitter_idx").on(t.submitter_id),
    index("submissions_user_id_idx").on(t.user_id),
  ],
);

export const submitters = sqliteTable(
  "submitters",
  {
    id: id(),
    // Links to the better-auth user id once auth exists; and/or an anonymous
    // `identifier` (email/phone) the submission was filed under.
    auth_user_id: text("auth_user_id"),
    identifier: text("identifier"),
    submissions_count: integer("submissions_count").notNull().default(0),
    approved_count: integer("approved_count").notNull().default(0),
    rejected_count: integer("rejected_count").notNull().default(0),
    trust_tier: text("trust_tier", { enum: ["anonymous", "new", "trusted"] }).notNull().default("new"),
    blocked: integer("blocked", { mode: "boolean" }).notNull().default(false),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [index("submitters_auth_user_idx").on(t.auth_user_id), index("submitters_identifier_idx").on(t.identifier)],
);

export const food_items = sqliteTable(
  "food_items",
  {
    id: id(),
    venue_id: text("venue_id")
      .notNull()
      .references(() => venues.id),
    item_type: text("item_type", { enum: ITEM_TYPES }).notNull(),
    name: text("name").notNull(),
    name_ms: text("name_ms"),
    description: text("description"),
    price_bnd: real("price_bnd"),
    category: text("category"),
    // Reviewer health tags e.g. high-protein, coach-recommended.
    tags: text("tags", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .$defaultFn(() => []),
    nutrition_estimate: text("nutrition_estimate", { mode: "json" }).$type<NutritionEstimate>(),
    // Product-only fields.
    brand: text("brand"),
    barcode: text("barcode"),
    package_size: text("package_size"),
    off_barcode: text("off_barcode"),
    source_submission_id: text("source_submission_id").references(() => submissions.id),
    // Set to the superseding submission's id when a newer approved menu
    // replaces this item. Kept for provenance; `is_current` is the live flag
    // public queries read (`superseded_by IS NULL` was the v1 proxy for it).
    superseded_by: text("superseded_by"),
    // The public menu is exactly the rows with is_current = true. Publish
    // sets it on inserted items and clears it (with status="superseded" +
    // superseded_by) on items a revision drops. Defaults true so a plain
    // insert is live, matching the v1 "published + unsuperseded" semantics.
    is_current: integer("is_current", { mode: "boolean" }).notNull().default(true),
    // Trusted-published scan items go live behind this badge until a
    // reviewer clears it (verify) or unpublishes — see spec §5.
    pending_verification: integer("pending_verification", { mode: "boolean" }).notNull().default(false),
    // JSON array of provider names that supplied the scan item's data
    // (e.g. ["openfoodfacts","eansearch"]) — provenance for reviewers.
    barcode_source: text("barcode_source", { mode: "json" }).$type<string[]>(),
    status: text("status", { enum: ["published", "superseded", "hidden"] }).notNull().default("published"),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    index("food_items_venue_idx").on(t.venue_id),
    index("food_items_superseded_idx").on(t.superseded_by),
    index("food_items_source_submission_idx").on(t.source_submission_id),
  ],
);

// One row per approved publish: who rewrote the venue's menu, from which
// submission, and how (replace = v1 wholesale swap; merge = per-item
// keep/add). This is the audit spine for food_items.is_current flips.
export const venue_revisions = sqliteTable(
  "venue_revisions",
  {
    id: id(),
    venue_id: text("venue_id")
      .notNull()
      .references(() => venues.id),
    submission_id: text("submission_id").references(() => submissions.id),
    // better-auth user id — kept as plain text, no drizzle-level FK, same
    // convention as submissions.reviewer_id (auth tables live outside the
    // tracked schema).
    reviewer_id: text("reviewer_id").notNull(),
    mode: text("mode", { enum: REVISION_MODES }).notNull(),
    created_at: createdAt(),
  },
  (t) => [
    index("venue_revisions_venue_idx").on(t.venue_id),
    index("venue_revisions_submission_idx").on(t.submission_id),
  ],
);

// One "is this menu still current?" vote per user per venue per UTC day —
// the day-scoping is enforced by a UNIQUE expression index on
// date(created_at) in migrations/0002_phase2.sql (hand-added, same
// convention as the auth-table FKs: drizzle can't express it). Votes feed
// the admin staleness list; `accurate=true` also bumps
// venues.last_verified_at. user_id follows the auth convention — plain
// text, no drizzle-level FK into the untracked "user" table.
export const verifications = sqliteTable(
  "verifications",
  {
    id: id(),
    venue_id: text("venue_id")
      .notNull()
      .references(() => venues.id),
    user_id: text("user_id").notNull(),
    accurate: integer("accurate", { mode: "boolean" }).notNull(),
    created_at: createdAt(),
  },
  (t) => [
    index("verifications_venue_idx").on(t.venue_id),
    index("verifications_user_idx").on(t.user_id),
  ],
);

// One "I ate here" check-in per user per venue per UTC day (and at most 20
// per user per day — the counted caps live in src/routes/checkins.ts). The
// day-scoping is enforced by a UNIQUE expression index on date(created_at)
// in migrations/0002_phase2.sql (hand-added — same convention as
// verifications_daily_idx). geo_lat/geo_lng are nullable device-supplied
// coordinates; menu_accurate is an optional "was the menu right?" answer
// that also writes a verifications row via recordVerification (Task 3
// semantics). user_id follows the auth convention — plain text, no
// drizzle-level FK into the untracked "user" table.
export const check_ins = sqliteTable(
  "check_ins",
  {
    id: id(),
    venue_id: text("venue_id")
      .notNull()
      .references(() => venues.id),
    user_id: text("user_id").notNull(),
    geo_lat: real("geo_lat"),
    geo_lng: real("geo_lng"),
    menu_accurate: integer("menu_accurate", { mode: "boolean" }),
    created_at: createdAt(),
  },
  (t) => [index("check_ins_venue_idx").on(t.venue_id), index("check_ins_user_idx").on(t.user_id)],
);

// A "we need a menu here" mission. Two shapes: attached to a stub venue
// (venue_id set — approving a submission onto that venue fulfills it) or a
// free-text name + area for a venue not in the dataset yet (a publish whose
// venue name+area matches fulfills it — see src/lib/publish.ts). `area` is
// stored on every row — copied from the venue for venue-linked requests —
// so the area filter and the coverage rollup don't need the join.
// requester_id follows the auth convention: plain-text better-auth user id,
// no drizzle-level FK into the untracked "user" table.
export const venue_requests = sqliteTable(
  "venue_requests",
  {
    id: id(),
    requester_id: text("requester_id").notNull(),
    venue_id: text("venue_id").references(() => venues.id),
    free_text_name: text("free_text_name"),
    area: text("area", { enum: AREAS }).notNull(),
    note: text("note"),
    status: text("status", { enum: VENUE_REQUEST_STATUSES }).notNull().default("open"),
    fulfilled_submission_id: text("fulfilled_submission_id").references(() => submissions.id),
    created_at: createdAt(),
  },
  (t) => [
    index("venue_requests_venue_idx").on(t.venue_id),
    index("venue_requests_status_idx").on(t.status),
    index("venue_requests_requester_idx").on(t.requester_id),
  ],
);

// Manual/honorary badge awards ONLY (e.g. community_star) — computed
// badges are evaluated at read time by src/lib/badges.ts and never write
// rows. One award per (user, badge) via the unique index. user_id and
// awarded_by follow the auth convention — plain-text better-auth user
// ids, no drizzle-level FK into the untracked "user" table.
export const user_badges = sqliteTable(
  "user_badges",
  {
    id: id(),
    user_id: text("user_id").notNull(),
    badge_key: text("badge_key").notNull(),
    awarded_by: text("awarded_by").notNull(),
    created_at: createdAt(),
  },
  (t) => [
    index("user_badges_user_idx").on(t.user_id),
    uniqueIndex("user_badges_user_key_idx").on(t.user_id, t.badge_key),
  ],
);

export const item_flags = sqliteTable(
  "item_flags",
  {
    id: id(),
    item_id: text("item_id")
      .notNull()
      .references(() => food_items.id),
    reason: text("reason").notNull(),
    reporter_contact: text("reporter_contact"),
    status: text("status", { enum: ["open", "resolved"] }).notNull().default("open"),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [index("item_flags_item_idx").on(t.item_id), index("item_flags_status_idx").on(t.status)],
);

// Normalized product payload stored in product_lookup_cache.merged_payload
// and returned by /api/products/lookup — see src/lib/product-lookup.ts.
export interface LookupProduct {
  name?: string;
  brand?: string;
  package_size?: string;
  nutrition_estimate?: NutritionEstimate;
  image_url?: string;
}

// Provenance for a lookup hit: which provider recognized the barcode, plus
// its (public, secret-free) product page when the provider exposes one.
export interface LookupSource {
  provider: string;
  url?: string;
}

// Barcode→product lookup cache (spec §2). One row per normalized code.
// `sources` also feeds the read-time TTL decision (OFF-family-only answers
// cache 30d, anything containing a commercial source 24h, negatives 7d —
// computed in src/lib/product-lookup.ts, no TTL column). Per-provider call
// budgets live in provider_budget instead of being derived from `sources`:
// `sources` records only providers that *recognized* the code, so misses
// and errors would undercount the spend.
export const product_lookup_cache = sqliteTable("product_lookup_cache", {
  code: text("code").primaryKey(),
  merged_payload: text("merged_payload", { mode: "json" }).$type<LookupProduct>().notNull(),
  sources: text("sources", { mode: "json" }).$type<LookupSource[]>().notNull(),
  found: integer("found", { mode: "boolean" }).notNull(),
  fetched_at: integer("fetched_at", { mode: "timestamp_ms" }).notNull(),
});

// Per-provider outbound-call counter, one row per (provider, UTC day).
// Commercial free tiers are tiny (ean-search ~200/day, upcitemdb ~100/day,
// barcodelookup ~50/day); product-lookup hard-stops a provider once its
// daily budget is spent rather than burning the trial. OFF-family is
// unlimited and never writes rows here.
export const provider_budget = sqliteTable(
  "provider_budget",
  {
    provider: text("provider").notNull(),
    day: text("day").notNull(),
    calls: integer("calls").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.provider, t.day] })],
);

export type Venue = typeof venues.$inferSelect;
export type NewVenue = typeof venues.$inferInsert;
export type FoodItem = typeof food_items.$inferSelect;
export type NewFoodItem = typeof food_items.$inferInsert;
export type Submission = typeof submissions.$inferSelect;
export type NewSubmission = typeof submissions.$inferInsert;
export type Submitter = typeof submitters.$inferSelect;
export type NewSubmitter = typeof submitters.$inferInsert;
export type ItemFlag = typeof item_flags.$inferSelect;
export type NewItemFlag = typeof item_flags.$inferInsert;
export type VenueRevision = typeof venue_revisions.$inferSelect;
export type NewVenueRevision = typeof venue_revisions.$inferInsert;
export type Verification = typeof verifications.$inferSelect;
export type NewVerification = typeof verifications.$inferInsert;
export type CheckIn = typeof check_ins.$inferSelect;
export type NewCheckIn = typeof check_ins.$inferInsert;
export type VenueRequest = typeof venue_requests.$inferSelect;
export type NewVenueRequest = typeof venue_requests.$inferInsert;
export type UserBadge = typeof user_badges.$inferSelect;
export type NewUserBadge = typeof user_badges.$inferInsert;
export type RevisionMode = (typeof REVISION_MODES)[number];
export type ProductLookupCacheRow = typeof product_lookup_cache.$inferSelect;
export type ProviderBudgetRow = typeof provider_budget.$inferSelect;
