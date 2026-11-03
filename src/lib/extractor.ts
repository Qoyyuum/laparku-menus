import type { NutritionEstimate } from "../db/schema";
import type { Env } from "../env";

// Draft produced by the vision model; reviewers edit this before approval.
export interface DraftItem {
  name: string;
  name_ms?: string;
  description?: string;
  price_bnd?: number;
  category?: string;
  item_type: "dish" | "product";
  brand?: string;
  barcode?: string;
  nutrition_estimate?: NutritionEstimate;
}

export interface ExtractionDraft {
  has_food_content: boolean;
  confidence: number;
  venue_guess: { name: string; type: string; area?: string } | null;
  items: DraftItem[];
  // Model-reported plausibility signals (off-market prices, venue/type
  // mismatch, visual artifacting). Flags only — never auto-reject.
  suspicion: string[];
}

export interface ExtractionImage {
  key: string;
  bytes: ArrayBuffer;
  mime: string;
}

// Below this confidence the draft is too unreliable to reach reviewers.
export const MIN_EXTRACTION_CONFIDENCE = 0.3;

const EXTRACTION_PROMPT = `You extract structured data from photos of menus, food packaging, nutrition labels and barcodes for a Brunei food database.
Respond with JSON only — no prose, no markdown fences — in exactly this shape:
{"has_food_content":boolean,"confidence":0..1,"venue_guess":{"name":string,"type":"restaurant|stall|supermarket|grocer|convenience","area"?:string}|null,"items":[{"name":string,"name_ms"?:string,"description"?:string,"price_bnd"?:number,"category"?:string,"item_type":"dish"|"product","brand"?:string,"barcode"?:string,"nutrition_estimate"?:object}],"suspicion":string[]}
Rules:
- has_food_content=false when the images show no menu, dish, product or label.
- suspicion: short snake_case tags for off-market prices in Brunei ("price_outlier"), dishes inconsistent with the venue type, visible AI-generation artifacting, or other oddities. Empty when nothing is suspicious.
- prices are in BND. item_type is "product" only for packaged goods with a brand/barcode.
- nutrition_estimate is your machine estimate for products with a readable label; omit otherwise.`;

// --- stub provider ---------------------------------------------------------

type StubSource =
  | ExtractionDraft
  | ((images: ExtractionImage[]) => ExtractionDraft | Promise<ExtractionDraft>);

const DEFAULT_STUB_DRAFT: ExtractionDraft = {
  has_food_content: true,
  confidence: 0.9,
  venue_guess: null,
  items: [],
  suspicion: [],
};

let stubSource: StubSource = DEFAULT_STUB_DRAFT;

/** Test hook: choose what the `stub` provider returns (value or callback). */
export function setStubExtractor(next: StubSource): void {
  stubSource = next;
}

export function resetStubExtractor(): void {
  stubSource = DEFAULT_STUB_DRAFT;
}

// --- provider dispatch -----------------------------------------------------

export async function extractContent(images: ExtractionImage[], env: Env): Promise<ExtractionDraft> {
  const provider = env.EXTRACTOR ?? "workers-ai";
  if (provider === "stub") {
    return typeof stubSource === "function" ? stubSource(images) : stubSource;
  }
  return extractWithWorkersAi(images, env);
}

// --- workers-ai provider ----------------------------------------------------

function toBase64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < view.length; i += CHUNK) {
    binary += String.fromCharCode(...view.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function parseDraft(text: string): ExtractionDraft {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error("extractor response contained no JSON object");
  }
  const raw = JSON.parse(text.slice(start, end + 1)) as Partial<ExtractionDraft>;
  if (typeof raw.has_food_content !== "boolean") {
    throw new Error("extractor JSON missing has_food_content");
  }
  return {
    has_food_content: raw.has_food_content,
    confidence: typeof raw.confidence === "number" ? Math.min(1, Math.max(0, raw.confidence)) : 0,
    venue_guess:
      raw.venue_guess && typeof raw.venue_guess.name === "string" ? raw.venue_guess : null,
    items: Array.isArray(raw.items) ? (raw.items as DraftItem[]) : [],
    suspicion: Array.isArray(raw.suspicion)
      ? raw.suspicion.filter((s): s is string => typeof s === "string")
      : [],
  };
}

async function extractWithWorkersAi(images: ExtractionImage[], env: Env): Promise<ExtractionDraft> {
  const content: unknown[] = [{ type: "text", text: EXTRACTION_PROMPT }];
  let skipped = 0;
  for (const image of images) {
    // Vision models take raster input; PDFs can't be inlined.
    if (!image.mime.startsWith("image/")) {
      skipped++;
      continue;
    }
    content.push({
      type: "image_url",
      image_url: { url: `data:${image.mime};base64,${toBase64(image.bytes)}` },
    });
  }
  if (skipped > 0) {
    content.push({ type: "text", text: `(${skipped} attached non-image document(s) not shown.)` });
  }

  const run = env.AI.run as (model: string, inputs: unknown) => Promise<unknown>;
  const result = await run(env.EXTRACTION_MODEL, {
    messages: [{ role: "user", content }],
    max_tokens: 2048,
  });
  const text =
    typeof result === "object" && result !== null && "response" in result
      ? String((result as { response: unknown }).response)
      : typeof result === "string"
        ? result
        : "";
  return parseDraft(text);
}
