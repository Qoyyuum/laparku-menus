import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { getDb } from "../db/client";
import type { Env } from "../env";
import { MAX_FILE_BYTES, sniffMagic, SNIFFED_MIME } from "../lib/files";
import { gravatarUrl } from "../lib/gravatar";
import { requireAuth, type AuthVariables } from "../middleware/auth";

// Avatars are smaller than menu photos — 2 MB cap vs the submission 8 MB.
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const ME_ROLES = ["submitter", "reviewer", "admin"];

const avatarApi = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

// POST /api/me/avatar — raw image body (not multipart): jpeg/png/webp only,
// sniffed from magic bytes (declared Content-Type is never trusted), ≤2 MB.
// Stored at a fixed R2 key so re-uploads overwrite; user.image points at the
// public serve route below.
avatarApi.post("/me/avatar", requireAuth(ME_ROLES), async (c) => {
  const userId = c.get("user").id;
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  if (bytes.length > MAX_AVATAR_BYTES) {
    return c.json({ error: `avatar must be at most ${MAX_AVATAR_BYTES} bytes` }, 413);
  }
  const type = sniffMagic(bytes);
  if (type !== "jpeg" && type !== "png" && type !== "webp") {
    return c.json({ error: "unsupported image type: jpeg, png or webp only" }, 400);
  }
  await c.env.SUBMISSIONS.put(`avatars/${userId}`, bytes, {
    httpMetadata: { contentType: SNIFFED_MIME[type] },
  });
  const avatarUrl = `/api/avatar/${userId}`;
  await getDb(c.env).run(sql`
    UPDATE "user" SET image = ${avatarUrl}, "updatedAt" = ${new Date().toISOString()} WHERE id = ${userId}
  `);
  return c.json({ avatar_url: avatarUrl });
});

// DELETE /api/me/avatar — removes the upload; the caller falls back to
// their Gravatar image (returned so the client can swap it straight in).
avatarApi.delete("/me/avatar", requireAuth(ME_ROLES), async (c) => {
  const userId = c.get("user").id;
  await c.env.SUBMISSIONS.delete(`avatars/${userId}`);
  const db = getDb(c.env);
  await db.run(sql`UPDATE "user" SET image = NULL, "updatedAt" = ${new Date().toISOString()} WHERE id = ${userId}`);
  const [u] = (await db.all(sql`SELECT email FROM "user" WHERE id = ${userId}`)) as { email: string }[];
  return c.json({ avatar_url: await gravatarUrl(u?.email ?? "") });
});

// GET /api/avatar/:userId — public serve route (leaderboard/profile renders
// need no session). Content-type comes from the metadata stored at upload,
// never the request. Short public cache; re-uploads overwrite in place.
avatarApi.get("/avatar/:userId", async (c) => {
  const obj = await c.env.SUBMISSIONS.get(`avatars/${c.req.param("userId")}`);
  if (!obj) return c.json({ error: "not found" }, 404);
  return new Response(obj.body, {
    headers: {
      "content-type": obj.httpMetadata?.contentType ?? "application/octet-stream",
      "cache-control": "public, max-age=3600",
    },
  });
});

export default avatarApi;
