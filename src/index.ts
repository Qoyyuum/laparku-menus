import { Hono } from "hono";
import { createAuth } from "./auth";
import type { Env } from "./env";
import { requireAuth } from "./middleware/auth";
import { handleQueueBatch, type SubmissionMessage } from "./queue";
import publicApi from "./routes/public";
import submissionsApi from "./routes/submissions";

const app = new Hono<{ Bindings: Env }>();

app.get("/api/health", (c) => c.json({ status: "ok" }));
// better-auth handler — per-request instance because the D1 binding only
// exists inside a request (see src/auth.ts).
app.on(["GET", "POST"], "/api/auth/*", (c) => createAuth(c.env).handler(c.req.raw));
app.route("/api", publicApi);
app.route("/api", submissionsApi);

// Reviewer surface stub — real admin/review routes land in Task 9+.
app.get("/api/admin/ping", requireAuth(["reviewer", "admin"]), (c) => c.json({ ok: true }));

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      return app.fetch(request, env, ctx);
    }
    // Everything else is the Expo web export served from the ASSETS binding;
    // `not_found_handling = "single-page-application"` in wrangler.toml serves
    // index.html for client-side routes (e.g. /search).
    return env.ASSETS.fetch(request);
  },
  async queue(batch: MessageBatch<SubmissionMessage>, env: Env): Promise<void> {
    await handleQueueBatch(batch, env);
  },
};
