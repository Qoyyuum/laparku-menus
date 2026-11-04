import { Hono } from "hono";
import type { Env } from "../env";
import { lookupProduct } from "../lib/product-lookup";
import { rateLimit } from "../middleware/rate-limit";

const productsApi = new Hono<{ Bindings: Env }>();

// GET /api/products/lookup/:code — public read (only writes need a session
// per the phase-2 rule), but rate-limited: a cold lookup fans out to ~7
// upstream calls under our UA, so code enumeration must not be free.
// :code must be 8–14 digits; resolves through the provider chain + D1
// cache in src/lib/product-lookup.ts.
productsApi.get("/products/lookup/:code", rateLimit, async (c) => {
  const result = await lookupProduct(c.req.param("code"), c.env);
  if (!result) return c.json({ error: "barcode must be 8–14 digits" }, 400);
  return c.json(result);
});

export default productsApi;
