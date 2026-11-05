import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import type { FoodItem, Venue } from "../src/db/schema";
import {
  itemDoc,
  metadataFilter,
  minScore,
  searchEnabled,
  venueDoc,
} from "../src/lib/search-index";

describe("search-index core", () => {
  it("itemDoc embeds bilingual name, description, tags and venue context", () => {
    const doc = itemDoc(
      {
        name: "Nasi Katok",
        name_ms: "ناسي کاتوق",
        description: "rice + sambal + chicken",
        category: "rice",
        tags: ["spicy"],
        item_type: "dish",
        price_bnd: 1.5,
      } as FoodItem,
      { name: "Kedai A", type: "restaurant", area: "Tutong" } as Venue,
    );
    expect(doc).toContain("Nasi Katok");
    expect(doc).toContain("Kedai A");
    expect(doc).toContain("Tutong");
    expect(doc).toContain("spicy");
  });

  it("itemDoc drops null fields without stray separators", () => {
    const doc = itemDoc(
      {
        name: "Fries",
        name_ms: null,
        description: null,
        category: null,
        tags: [],
        item_type: "dish",
      } as unknown as FoodItem,
      { name: "V", type: "stall", area: "Belait" } as Venue,
    );
    expect(doc).not.toMatch(/null|undefined/);
  });

  it("venueDoc embeds name, type, area, address, halal", () => {
    const doc = venueDoc({
      name: "Kedai A",
      name_ms: null,
      type: "restaurant",
      area: "Tutong",
      address: "Jalan X",
      halal_status: "halal-certified",
    } as Venue);
    expect(doc).toContain("Kedai A");
    expect(doc).toContain("restaurant");
    expect(doc).toContain("Tutong");
    expect(doc).toContain("halal-certified");
    expect(doc).not.toMatch(/null|undefined/);
  });

  it("metadataFilter maps filters; venue queries ignore item-only keys", () => {
    const f = {
      area: "Tutong",
      halal: "halal-certified",
      itemType: "dish",
      venueType: "restaurant",
      maxPrice: 5,
    };
    expect(metadataFilter("item", f)).toEqual({
      kind: "item",
      area: "Tutong",
      halal: "halal-certified",
      item_type: "dish",
      venue_type: "restaurant",
      price_bnd: { $lte: 5 },
    });
    expect(metadataFilter("venue", f)).toEqual({
      kind: "venue",
      area: "Tutong",
      halal: "halal-certified",
      venue_type: "restaurant",
    });
  });

  it("searchEnabled requires provider=vectorize AND the binding", () => {
    expect(
      searchEnabled({ SEARCH_PROVIDER: "like", SEARCH_INDEX: {} } as unknown as Env),
    ).toBe(false);
    expect(searchEnabled({ SEARCH_PROVIDER: "vectorize" } as unknown as Env)).toBe(false);
    expect(
      searchEnabled({ SEARCH_PROVIDER: "vectorize", SEARCH_INDEX: {} } as unknown as Env),
    ).toBe(true);
  });

  it("minScore parses the var, defaults 0.5", () => {
    expect(minScore({} as Env)).toBe(0.5);
    expect(minScore({ SEARCH_MIN_SCORE: "0.7" } as Env)).toBe(0.7);
    expect(minScore({ SEARCH_MIN_SCORE: "junk" } as Env)).toBe(0.5);
  });
});
