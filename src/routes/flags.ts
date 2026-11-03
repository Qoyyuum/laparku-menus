import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { getDb } from "../db/client";
import { food_items, item_flags } from "../db/schema";
import type { Env } from "../env";
import { verifyTurnstile } from "../lib/turnstile";

// Flag reasons are free text shown to reviewers — bounded so a single
// report can't dump a megabyte into the admin queue.
const MAX_REASON_LEN = 2000;
const MAX_CONTACT_LEN = 320;

const flagsApi = new Hono<{ Bindings: Env }>();

// POST /api/items/:id/flag — public post-publish report ("this price is
// wrong", "restaurant closed"). JSON body:
// { reason: string, reporter_contact?: string, turnstile_token?: string }.
// The item must exist and be published — flagging a superseded/hidden item
// would surface reports on rows the public can't see anyway.
//
// Turnstile rules mirror POST /api/submissions: skipped when the secret
// isn't configured (dev/tests) and for native app clients — they can't run
// the web widget, send X-Laparku-Client: app instead.
flagsApi.post("/items/:id/flag", async (c) => {
  let body: { reason?: unknown; reporter_contact?: unknown; turnstile_token?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "expected JSON body" }, 400);
  }
  if (typeof body !== "object" || body === null) {
    return c.json({ error: "expected JSON body" }, 400);
  }

  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (!reason) return c.json({ error: "reason is required" }, 400);
  if (reason.length > MAX_REASON_LEN) {
    return c.json({ error: `reason too long (max ${MAX_REASON_LEN} chars)` }, 400);
  }
  const reporterContact =
    typeof body.reporter_contact === "string" && body.reporter_contact.trim() !== ""
      ? body.reporter_contact.trim()
      : null;
  if (reporterContact && reporterContact.length > MAX_CONTACT_LEN) {
    return c.json({ error: `reporter_contact too long (max ${MAX_CONTACT_LEN} chars)` }, 400);
  }

  const isAppClient = c.req.header("X-Laparku-Client") === "app";
  if (c.env.TURNSTILE_SECRET_KEY && !isAppClient) {
    const token = typeof body.turnstile_token === "string" ? body.turnstile_token : "";
    const ok = token
      ? await verifyTurnstile(c.env.TURNSTILE_SECRET_KEY, token, c.req.header("CF-Connecting-IP"))
      : false;
    if (!ok) return c.json({ error: "turnstile verification failed" }, 403);
  }

  const db = getDb(c.env);
  const [item] = await db
    .select({ id: food_items.id })
    .from(food_items)
    .where(and(eq(food_items.id, c.req.param("id")), eq(food_items.status, "published")))
    .limit(1);
  if (!item) return c.json({ error: "item not found" }, 404);

  const [flag] = await db
    .insert(item_flags)
    .values({ item_id: item.id, reason, reporter_contact: reporterContact, status: "open" })
    .returning({ id: item_flags.id });
  return c.json({ id: flag!.id }, 201);
});

export default flagsApi;
