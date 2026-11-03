import { Hono } from "hono";
import type { Env } from "./env";
import publicApi from "./routes/public";

const app = new Hono<{ Bindings: Env }>();

app.get("/api/health", (c) => c.json({ status: "ok" }));
app.route("/api", publicApi);

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      return app.fetch(request, env, ctx);
    }
    // Everything else is the Expo web export served from the ASSETS binding;
    // fall back to index.html so client-side routes (e.g. /search) resolve.
    const res = await env.ASSETS.fetch(request);
    if (res.status === 404 && request.method === "GET") {
      return env.ASSETS.fetch(new Request(new URL("/index.html", request.url).toString(), request));
    }
    return res;
  },
  async queue(
    _batch: MessageBatch<unknown>,
    _env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    // Stub: submission extraction/review pipeline lands in a later task.
  },
};
