import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { createAuth } from "./auth";
import { getDb } from "./db/client";
import { AREAS, HALAL_STATUSES, ITEM_TYPES, SOURCE_TYPES, submissions, submitters, VENUE_TYPES } from "./db/schema";
import type { Env } from "./env";
import { listPublishedVenues, listVenueItems, searchPublic } from "./routes/public";
import { intakeFileSubmission, intakeManualSubmission, type IntakeResult } from "./routes/submissions";

// --- auth ------------------------------------------------------------------
// submit_menu / get_submission_status take `api_key` as a tool ARGUMENT, not
// a header — MCP clients can't always set per-request headers on the shared
// /mcp connection, while tool args are always available. The key is verified
// through the better-auth apiKey plugin; the verified key's referenceId is
// the better-auth user id, which scopes visibility to that user's
// submissions.

async function verifyKey(env: Env, key: string): Promise<{ userId: string } | null> {
  const res = await createAuth(env).api.verifyApiKey({ body: { key } });
  if (!res.valid || !res.key) return null;
  return { userId: res.key.referenceId };
}

// --- result helpers ---------------------------------------------------------

function ok(data: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
    structuredContent: data,
  };
}

function toolError(message: string) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: message }],
  };
}

function authError() {
  return toolError("invalid api key: provide a valid better-auth API key in the `api_key` argument");
}

// IntakeResult → tool result: 2xx returns the body as structured content,
// anything else is a tool error carrying the same message the HTTP route
// would have returned.
function intakeToTool(result: IntakeResult) {
  if (result.status >= 200 && result.status < 300) return ok(result.body);
  const message = typeof result.body.error === "string" ? result.body.error : JSON.stringify(result.body);
  return toolError(message);
}

// --- server -----------------------------------------------------------------

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> | null {
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

const venueFilterShape = {
  type: z.enum(VENUE_TYPES).optional(),
  area: z.enum(AREAS).optional(),
  halal: z.enum(HALAL_STATUSES).optional(),
  q: z.string().optional().describe("substring match on venue name (English or Malay)"),
};

export function createMcpServer(env: Env): McpServer {
  const server = new McpServer({ name: "laparku-menus", version: "0.1.0" });

  server.registerTool(
    "search_items",
    {
      description:
        "Search published food items and venues. `query` is a substring match against item " +
        "name/description and venue name; `filters` narrows by venue/item type, area, halal " +
        "status, tag and max price in BND.",
      inputSchema: {
        query: z.string().describe("substring match on item name/description and venue name"),
        filters: z
          .object({
            venue_type: z.enum(VENUE_TYPES).optional(),
            item_type: z.enum(ITEM_TYPES).optional(),
            area: z.enum(AREAS).optional(),
            halal: z.enum(HALAL_STATUSES).optional(),
            tag: z.string().optional().describe("exact element match against the item's tags array"),
            max_price: z.number().nonnegative().optional().describe("max price in BND"),
          })
          .optional(),
      },
    },
    async ({ query, filters }) => {
      const result = await searchPublic(env, {
        venueType: filters?.venue_type,
        itemType: filters?.item_type,
        area: filters?.area,
        halal: filters?.halal,
        tag: filters?.tag,
        maxPrice: filters?.max_price,
        q: query,
      });
      return ok(result as unknown as Record<string, unknown>);
    },
  );

  server.registerTool(
    "list_venues",
    {
      description: "List published venues, optionally filtered by type, area, halal status or name query.",
      inputSchema: { filters: z.object(venueFilterShape).optional() },
    },
    async ({ filters }) => {
      const venues = await listPublishedVenues(env, {
        type: filters?.type,
        area: filters?.area,
        halal: filters?.halal,
        q: filters?.q,
      });
      return ok({ venues });
    },
  );

  server.registerTool(
    "get_venue_items",
    {
      description: "List the live (published, non-superseded) menu items of one published venue.",
      inputSchema: { venue_id: z.string() },
    },
    async ({ venue_id }) => {
      const items = await listVenueItems(env, venue_id);
      if (!items) return toolError("venue not found (or not published)");
      return ok({ items });
    },
  );

  server.registerTool(
    "submit_menu",
    {
      description:
        "File a menu submission for review. Requires a valid API key in `api_key`. " +
        "payload.source_type=manual_entry takes `items` (structured text entry); the other " +
        "source types take `files` as base64 (jpeg/png/webp/pdf) — except `url`, which puts " +
        "the link in `provenance`. Same validation as POST /api/submissions.",
      inputSchema: {
        api_key: z.string().describe("better-auth API key; determines which submissions are visible to you"),
        payload: z.object({
          source_type: z.enum(SOURCE_TYPES),
          provenance: z.string().describe("where the menu data came from — IG handle, physical menu, PDF link, ..."),
          contact: z.string().optional().describe("contact email recorded on the submission"),
          items: z.array(z.record(z.string(), z.unknown())).optional().describe("manual_entry only: structured menu items"),
          files: z
            .array(z.object({ name: z.string().optional(), content_base64: z.string() }))
            .optional()
            .describe("file payloads as base64; type is detected from magic bytes"),
        }),
      },
    },
    async ({ api_key, payload }) => {
      const auth = await verifyKey(env, api_key);
      if (!auth) return authError();

      if (payload.source_type === "manual_entry") {
        return intakeToTool(
          await intakeManualSubmission(env, {
            authUserId: auth.userId,
            provenance: payload.provenance,
            contact: payload.contact ?? null,
            items: payload.items,
          }),
        );
      }

      const files = payload.files ?? [];
      const decoded: Uint8Array<ArrayBuffer>[] = [];
      for (const f of files) {
        const bytes = base64ToBytes(f.content_base64);
        if (!bytes) return toolError("invalid base64 in files[].content_base64");
        decoded.push(bytes);
      }
      return intakeToTool(
        await intakeFileSubmission(env, {
          sourceType: payload.source_type,
          provenance: payload.provenance,
          email: payload.contact,
          authUserId: auth.userId,
          files: decoded.map((bytes) => ({ size: bytes.length, bytes: async () => bytes })),
        }),
      );
    },
  );

  server.registerTool(
    "get_submission_status",
    {
      description:
        "Look up one of your own submissions by id. Requires the same `api_key` used to " +
        "submit — a key can only see submissions filed under its own user.",
      inputSchema: {
        id: z.string().describe("submission id returned by submit_menu"),
        api_key: z.string(),
      },
    },
    async ({ id, api_key }) => {
      const auth = await verifyKey(env, api_key);
      if (!auth) return authError();

      const db = getDb(env);
      const [submitter] = await db
        .select({ id: submitters.id })
        .from(submitters)
        .where(eq(submitters.auth_user_id, auth.userId))
        .limit(1);
      if (!submitter) return toolError("submission not found");

      const [row] = await db
        .select({
          id: submissions.id,
          status: submissions.status,
          source_type: submissions.source_type,
          rejection_reason: submissions.rejection_reason,
          auto_flags: submissions.auto_flags,
          created_at: submissions.created_at,
          updated_at: submissions.updated_at,
        })
        .from(submissions)
        .where(and(eq(submissions.id, id), eq(submissions.submitter_id, submitter.id)))
        .limit(1);
      if (!row) return toolError("submission not found");
      return ok(row as unknown as Record<string, unknown>);
    },
  );

  return server;
}

// --- transport ---------------------------------------------------------------
// Stateless Streamable HTTP: no session ids, a fresh McpServer + transport per
// request (a Worker can't hold session state between invocations anyway).
// enableJsonResponse returns plain JSON-RPC bodies instead of SSE frames for
// request/response messages — the transport still accepts the mandatory
// `Accept: application/json, text/event-stream` handshake.

export async function handleMcpRequest(request: Request, env: Env): Promise<Response> {
  const server = createMcpServer(env);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    // Stateless transport holds no per-session resources once the response is
    // produced; closing also tears down the per-request server instance.
    transport.close().catch(() => {});
  }
}
