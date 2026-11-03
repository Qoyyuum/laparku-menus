import { env, SELF } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { createAuth } from "../src/auth";
import { getDb } from "../src/db/client";
import { submissions, venues as venuesTable } from "../src/db/schema";
import { forgeSession } from "./helpers/auth";
import { seed } from "./helpers/seed";

// Streamable HTTP transport: clients must accept both JSON and SSE.
const MCP_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

let nextId = 1;
function rpc(method: string, params?: unknown) {
  return SELF.fetch("https://x/mcp", {
    method: "POST",
    headers: MCP_HEADERS,
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
}

function callTool(name: string, args: Record<string, unknown>) {
  return rpc("tools/call", { name, arguments: args });
}

interface ToolResultBody {
  result?: {
    content?: { type: string; text?: string }[];
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  };
  error?: { code: number; message: string };
}

async function callToolJson(name: string, args: Record<string, unknown>): Promise<ToolResultBody> {
  const res = await callTool(name, args);
  expect(res.status).toBe(200);
  return (await res.json()) as ToolResultBody;
}

// Mints a real better-auth API key for a forged user (server-side call — no
// session needed when `userId` is supplied outside a request context).
async function makeApiKey(): Promise<{ key: string; userId: string }> {
  const { userId } = await forgeSession("submitter");
  const created = await createAuth(env).api.createApiKey({ body: { userId, name: "mcp-test" } });
  expect(created.key).toBeTruthy();
  return { key: created.key, userId };
}

it("JSON-RPC initialize returns server capabilities with tools", async () => {
  const res = await rpc("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "test", version: "0" },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    result: { protocolVersion: string; serverInfo: { name: string }; capabilities: Record<string, unknown> };
  };
  expect(body.result.protocolVersion).toBeTruthy();
  expect(body.result.serverInfo.name).toBe("laparku-menus");
  expect(body.result.capabilities.tools).toBeTruthy();
});

it("tools/list exposes the five tools", async () => {
  const res = await rpc("tools/list");
  const body = (await res.json()) as { result: { tools: { name: string }[] } };
  const names = body.result.tools.map((t) => t.name);
  for (const t of ["search_items", "list_venues", "get_venue_items", "submit_menu", "get_submission_status"]) {
    expect(names).toContain(t);
  }
});

it("tools/call search_items returns the seeded item", async () => {
  await seed(env);
  const body = await callToolJson("search_items", { query: "katok" });
  expect(body.result?.isError).not.toBe(true);
  const items = (body.result?.structuredContent?.items ?? []) as { name: string }[];
  expect(items.map((i) => i.name)).toContain("Nasi Katok");
  expect(items.map((i) => i.name)).not.toContain("Old Menu Item");
});

it("tools/call search_items honors filters", async () => {
  await seed(env);
  const body = await callToolJson("search_items", {
    query: "katok",
    filters: { max_price: 1.0 },
  });
  const items = (body.result?.structuredContent?.items ?? []) as { name: string }[];
  expect(items.map((i) => i.name)).not.toContain("Nasi Katok");
});

it("tools/call list_venues filters and only returns published venues", async () => {
  const { venue } = await seed(env);
  const db = getDb(env);
  await db
    .insert(venuesTable)
    .values({ name: "Draft Shop", type: "convenience", area: "Tutong", status: "draft" });

  const body = await callToolJson("list_venues", {
    filters: { type: "restaurant", area: "Brunei-Muara" },
  });
  const venues = (body.result?.structuredContent?.venues ?? []) as { id: string; name: string }[];
  expect(venues.map((v) => v.id)).toContain(venue.id);
  expect(venues.map((v) => v.name)).not.toContain("Draft Shop");
});

it("tools/call get_venue_items returns live items; unknown venue is a tool error", async () => {
  const { venue } = await seed(env);
  const body = await callToolJson("get_venue_items", { venue_id: venue.id });
  const items = (body.result?.structuredContent?.items ?? []) as { name: string }[];
  expect(items.map((i) => i.name)).toContain("Nasi Katok");
  expect(items.map((i) => i.name)).not.toContain("Old Menu Item");

  const missing = await callToolJson("get_venue_items", { venue_id: "does-not-exist" });
  expect(missing.result?.isError).toBe(true);
});

it("submit_menu with a bad api_key returns an auth error", async () => {
  const body = await callToolJson("submit_menu", {
    api_key: "not-a-real-key",
    payload: {
      source_type: "manual_entry",
      provenance: "typed in by the owner",
      items: [{ name: "Teh Tarik", price_bnd: 1.0 }],
    },
  });
  expect(body.result?.isError).toBe(true);
  expect(body.result?.content?.[0]?.text).toMatch(/api key/i);
});

it("submit_menu manual_entry creates a pending submission for the key's user", async () => {
  const { key, userId } = await makeApiKey();
  const body = await callToolJson("submit_menu", {
    api_key: key,
    payload: {
      source_type: "manual_entry",
      provenance: "dictated by the stall owner",
      contact: "owner@example.com",
      items: [{ name: "Kolomee", price_bnd: 3.0 }],
    },
  });
  expect(body.result?.isError).not.toBe(true);
  const id = body.result?.structuredContent?.id as string;
  expect(id).toBeTruthy();

  const [row] = await getDb(env).select().from(submissions).where(eq(submissions.id, id));
  expect(row?.source_type).toBe("manual_entry");
  expect(row?.contact).toBe("owner@example.com");
  // API-key identity lands on the same user_id column as session submits.
  expect(row?.user_id).toBe(userId);
});

it("submit_menu rejects an invalid source_type", async () => {
  const { key } = await makeApiKey();
  const body = await callToolJson("submit_menu", {
    api_key: key,
    payload: { source_type: "smoke_signal", provenance: "x" },
  });
  // The tool's input schema enforces the SOURCE_TYPES enum → isError tool
  // result (InvalidParams surfaced as a tool error by the SDK).
  expect(body.result?.isError).toBe(true);
  expect(body.result?.content?.[0]?.text).toMatch(/source_type/);
  expect(body.result?.structuredContent?.id).toBeUndefined();
});

it("get_submission_status is scoped to the calling key's submissions", async () => {
  const alice = await makeApiKey();
  const bob = await makeApiKey();

  const created = await callToolJson("submit_menu", {
    api_key: alice.key,
    payload: {
      source_type: "manual_entry",
      provenance: "alice's own menu notes",
      items: [{ name: "Ambuyat", price_bnd: 5.0 }],
    },
  });
  const id = created.result?.structuredContent?.id as string;
  expect(id).toBeTruthy();

  // Alice can see her own submission.
  const own = await callToolJson("get_submission_status", { id, api_key: alice.key });
  expect(own.result?.isError).not.toBe(true);
  const status = own.result?.structuredContent;
  expect(status?.id).toBe(id);
  expect(typeof status?.status).toBe("string");

  // Bob's key cannot.
  const other = await callToolJson("get_submission_status", { id, api_key: bob.key });
  expect(other.result?.isError).toBe(true);
});
