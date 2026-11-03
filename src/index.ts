import { Hono } from "hono";
import type { Env } from "./env";
import publicApi from "./routes/public";

const app = new Hono<{ Bindings: Env }>();

app.get("/api/health", (c) => c.json({ status: "ok" }));
app.route("/api", publicApi);

export default {
  fetch: app.fetch,
  async queue(
    _batch: MessageBatch<unknown>,
    _env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    // Stub: submission extraction/review pipeline lands in a later task.
  },
};
