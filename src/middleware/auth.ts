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

// requireAuth(roles) — 401 when there's no valid session, 403 for banned
// users or when none of the session user's roles are in `roles`. The admin
// plugin stores multiple roles comma-separated in user.role (its setRole
// endpoint accepts an array), so we split before comparing. Users without a
// role count as "submitter".
export function requireAuth(roles: string[]) {
  return createMiddleware<{ Bindings: Env; Variables: AuthVariables }>(async (c, next) => {
    const session = await createAuth(c.env).api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: "unauthorized" }, 401);
    if (session.user.banned) return c.json({ error: "forbidden" }, 403);
    const userRoles = (session.user.role ?? "submitter").split(",");
    if (!userRoles.some((r) => roles.includes(r))) return c.json({ error: "forbidden" }, 403);
    c.set("user", session.user as AuthUser);
    c.set("session", session.session);
    await next();
  });
}
