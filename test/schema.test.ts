import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import { getDb } from "../src/db/client";
import { food_items, venues } from "../src/db/schema";

it("inserts and reads a venue with a food item", async () => {
  const db = getDb(env);
  const [v] = await db.insert(venues).values({ name: "Test Resto", type: "restaurant", area: "Brunei-Muara" }).returning();
  const [i] = await db.insert(food_items).values({ venue_id: v!.id, item_type: "dish", name: "Nasi Katok", price_bnd: 1.5 }).returning();
  expect(i!.name).toBe("Nasi Katok");
});
