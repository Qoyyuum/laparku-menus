import { Hono } from "hono";
import { createAuth } from "./auth";
import type { Env } from "./env";
import { handleMcpRequest } from "./mcp";
import { handleQueueBatch, type SubmissionMessage } from "./queue";
import adminApi from "./routes/admin";
import checkinsApi from "./routes/checkins";
import flagsApi from "./routes/flags";
import publicApi from "./routes/public";
import submissionsApi from "./routes/submissions";
import verifyApi from "./routes/verify";

const app = new Hono<{ Bindings: Env }>();

app.get("/api/health", (c) => c.json({ status: "ok" }));
// better-auth handler — per-request instance because the D1 binding only
// exists inside a request (see src/auth.ts).
app.on(["GET", "POST"], "/api/auth/*", (c) => createAuth(c.env).handler(c.req.raw));
app.route("/api", publicApi);
app.route("/api", submissionsApi);
app.route("/api", flagsApi);
app.route("/api", verifyApi);
app.route("/api", checkinsApi);
app.route("/api/admin", adminApi);

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      return app.fetch(request, env, ctx);
    }
    // MCP endpoint (Task 11) — Streamable HTTP transport, stateless. POST is
    // the only useful method; the transport answers GET/DELETE correctly.
    if (url.pathname === "/mcp") {
      return handleMcpRequest(request, env);
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
