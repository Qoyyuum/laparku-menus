const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

// Canonical server-side siteverify. Fails closed: missing token, network
// error, non-2xx, or a malformed response all return false.
export async function verifyTurnstile(secret: string, token: string, ip?: string): Promise<boolean> {
  // Unset secret = verification disabled (dev); the function itself honors the
  // skip rule so future callers can't accidentally fail closed with no secret.
  if (!secret) return true;
  if (!token) return false;
  const body = new URLSearchParams({ secret, response: token });
  if (ip) body.set("remoteip", ip);
  try {
    const res = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { success?: unknown };
    return data.success === true;
  } catch {
    return false;
  }
}
