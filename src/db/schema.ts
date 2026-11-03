import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

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
export const SUBMISSION_STATUSES = ["pending", "pending_review", "auto_rejected", "rejected", "approved"] as const;

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
    // replaces this item. `IS NULL` = currently live.
    superseded_by: text("superseded_by"),
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
