import { createMiddleware } from "hono/factory";
import { createAuth } from "../auth";
import type { Env } from "../env";

export interface AuthUser {
  id: string;
  email: string;
  role?: string | null;
  banned?: boolean | null;
  [key: string]: unknown;
}

export interface AuthVariables {
  user: AuthUser;
  session: unknown;
}

// requireAuth(roles) — 401 when there's no valid session, 403 when the
// session user's role isn't in `roles`. Users without a role (possible on
// rows created outside the admin plugin's defaults) count as "submitter".
export function requireAuth(roles: string[]) {
  return createMiddleware<{ Bindings: Env; Variables: AuthVariables }>(async (c, next) => {
    const session = await createAuth(c.env).api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: "unauthorized" }, 401);
    const role = session.user.role ?? "submitter";
    if (!roles.includes(role)) return c.json({ error: "forbidden" }, 403);
    c.set("user", session.user as AuthUser);
    c.set("session", session.session);
    await next();
  });
}
