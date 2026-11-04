import type { FoodItem } from "../db/schema";
import type { DraftItem } from "./extractor";

// A merge-mode suggestion: which existing menu item (if any) a draft row
// probably restates. Reviewers confirm or ignore — never auto-applied.
export interface MatchSuggestion {
  draftIndex: number;
  existingItemId: string | null;
}

// Prices this far apart (relative to the existing item) still count as "the
// same dish" — menu photos are often slightly stale on price.
const PRICE_TOLERANCE = 0.2;

// Comparison key: case, surrounding/inner whitespace and unicode canon don't
// distinguish dishes ("Nasi Katok" ≡ "nasi  katok").
export function normalizeItemName(name: string): string {
  return name.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}

// A suggestion is a name match that the price doesn't rule out. A missing
// price on either side can't disprove the match — the reviewer is the
// decision-maker, the suggestion just saves them a scan.
function priceCompatible(draftPrice: number | undefined, existingPrice: number | null): boolean {
  if (draftPrice === undefined || existingPrice === null) return true;
  return Math.abs(draftPrice - existingPrice) <= PRICE_TOLERANCE * existingPrice;
}

// Comparison key for packaged products: whitespace/case don't distinguish
// codes, but every digit does (no fuzzy matching — a digit off is a
// different product).
export function normalizeBarcodeForMatch(barcode: string): string {
  return barcode.trim();
}

// Pre-match each draft item against the venue's existing menu. Match keys
// in strength order (spec §7): exact barcode equality is the strongest
// signal — it outranks normalized-name+price similarity entirely, because a
// scanned code identifies the product exactly while names/prices drift.
// Within the name+price tier, when several existing items share the name,
// the closest price wins; a draft with no candidate gets existingItemId:
// null.
export function matchItems(drafts: DraftItem[], existing: FoodItem[]): MatchSuggestion[] {
  return drafts.map((draft, draftIndex) => {
    const barcode = draft.barcode ? normalizeBarcodeForMatch(draft.barcode) : "";
    if (barcode) {
      const hit = existing.find((i) => i.barcode !== null && normalizeBarcodeForMatch(i.barcode) === barcode);
      if (hit) return { draftIndex, existingItemId: hit.id };
    }

    const key = normalizeItemName(draft.name);
    let best: FoodItem | null = null;
    let bestDiff = Number.POSITIVE_INFINITY;
    for (const item of existing) {
      if (normalizeItemName(item.name) !== key) continue;
      if (!priceCompatible(draft.price_bnd, item.price_bnd)) continue;
      // An unpriced match still counts but loses to any priced one.
      const diff =
        draft.price_bnd !== undefined && item.price_bnd !== null
          ? Math.abs(draft.price_bnd - item.price_bnd)
          : Number.MAX_VALUE;
      if (diff < bestDiff) {
        best = item;
        bestDiff = diff;
      }
    }
    return { draftIndex, existingItemId: best?.id ?? null };
  });
}
