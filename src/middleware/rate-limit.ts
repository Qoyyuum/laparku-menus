import { createMiddleware } from "hono/factory";
import type { Env } from "../env";

// Per-IP rate limit for write endpoints (POST /api/submissions*,
// POST /api/items/:id/flag), backed by the [[ratelimits]] binding in
// wrangler.toml — 10 requests per 60s window (Cloudflare's only granularities
// are 10s and 60s; we use the minute window per the deploy plan).
//
// Keyed on CF-Connecting-IP, which the Cloudflare edge always sets on real
// traffic (and can't be spoofed past the edge). When the binding or the
// header is absent — local dev and the vitest-pool-workers test env — the
// middleware is a no-op rather than failing closed, so unauthenticated
// probing in environments without the binding is never blocked.
export const rateLimit = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  const limiter = c.env.RATE_LIMITER;
  const ip = c.req.header("CF-Connecting-IP");
  if (limiter && ip) {
    const { success } = await limiter.limit({ key: ip });
    if (!success) return c.json({ error: "rate limit exceeded" }, 429);
  }
  await next();
});
