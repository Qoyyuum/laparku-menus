import { Hono } from "hono";
import type { Env } from "./env";
import { handleQueueBatch, type SubmissionMessage } from "./queue";
import publicApi from "./routes/public";
import submissionsApi from "./routes/submissions";

const app = new Hono<{ Bindings: Env }>();

app.get("/api/health", (c) => c.json({ status: "ok" }));
app.route("/api", publicApi);
app.route("/api", submissionsApi);

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
