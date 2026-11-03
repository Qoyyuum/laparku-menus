// better-auth client for the Expo app.
//
// On web the session is a normal same-origin cookie — the worker serves both
// the export and /api. On native, the expoClient plugin persists the session
// cookie in expo-secure-store and attaches it to requests; admin API calls go
// through `adminFetch` below, which forwards the stored cookie as a header.
import { expoClient } from "@better-auth/expo/client";
import { createAuthClient } from "better-auth/react";
import { adminClient, magicLinkClient } from "better-auth/client/plugins";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import { API_BASE, AUTH_ORIGIN } from "./api";

export const authClient = createAuthClient({
  // Empty AUTH_ORIGIN = same-origin web build; undefined lets the client
  // resolve window.location.origin on its own.
  baseURL: AUTH_ORIGIN || undefined,
  plugins: [
    expoClient({
      scheme: "app",
      storagePrefix: "laparku",
      storage: SecureStore,
    }),
    magicLinkClient(),
    adminClient(),
  ],
});

export class AdminApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "AdminApiError";
  }
}

// The expoClient plugin stores the session cookie in SecureStore; read it
// out for requests native fetch won't attach it to (it has no cookie jar).
export async function getAuthCookie(): Promise<string> {
  return (await authClient.getCookie()) ?? "";
}

// fetch() for /api/admin/* with the better-auth session attached. Web relies
// on the same-origin session cookie; native passes the expoClient-stored
// cookie explicitly.
export async function adminFetch<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  if (Platform.OS !== "web" && API_BASE.startsWith("/")) {
    throw new AdminApiError(0, "EXPO_PUBLIC_API_URL is not set — native builds need the deployed worker API URL.");
  }
  const headers: Record<string, string> = {};
  if (init?.body != null) headers["content-type"] = "application/json";
  if (init?.headers) {
    for (const [k, v] of Object.entries(init.headers as Record<string, string>)) headers[k] = v;
  }
  if (Platform.OS !== "web") {
    const cookie = await getAuthCookie();
    if (cookie) headers.cookie = cookie;
  }
  const res = await fetch(`${API_BASE}${path.startsWith("/") ? path : `/${path}`}`, {
    ...init,
    headers,
    credentials: "include",
  });
  if (!res.ok) {
    let message = `API request failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // non-JSON error body — keep the status-based message
    }
    throw new AdminApiError(res.status, message);
  }
  return res.json() as Promise<T>;
}

// Whether the signed-in user can see the reviewer surface. The admin plugin
// stores multiple roles comma-separated — match on any one, mirroring
// requireAuth in src/middleware/auth.ts.
export function isReviewer(user: { role?: string | null } | null | undefined): boolean {
  const roles = (user?.role ?? "submitter").split(",").map((r) => r.trim());
  return roles.some((r) => r === "reviewer" || r === "admin");
}
