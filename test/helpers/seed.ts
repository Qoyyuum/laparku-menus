import type { Env } from "../../src/env";
import { getDb } from "../../src/db/client";
import { food_items, venues, type FoodItem, type Venue } from "../../src/db/schema";

export interface SeedResult {
  venue: Venue;
  items: FoodItem[];
}

// One fixture venue with a live item and a superseded item — enough for the
// public read API tests (search, halal filter, price filter, superseded
// exclusion) in later tasks.
export async function seed(env: Env): Promise<SeedResult> {
  const db = getDb(env);
  const [venue] = await db
    .insert(venues)
    .values({
      name: "Test Resto",
      type: "restaurant",
      area: "Brunei-Muara",
      halal_status: "muslim-owned",
    })
    .returning();
  const items = await db
    .insert(food_items)
    .values([
      { venue_id: venue!.id, item_type: "dish", name: "Nasi Katok", price_bnd: 1.5 },
      {
        venue_id: venue!.id,
        item_type: "dish",
        name: "Old Menu Item",
        price_bnd: 2.0,
        superseded_by: "superseded-fixture",
        status: "superseded",
      },
    ])
    .returning();
  return { venue: venue!, items };
}
