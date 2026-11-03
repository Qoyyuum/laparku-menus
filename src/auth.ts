import { apiKey } from "@better-auth/api-key";
import { betterAuth } from "better-auth";
import { admin, magicLink } from "better-auth/plugins";
import type { Env } from "./env";
import { sendEmail } from "./lib/notify";

export type Auth = ReturnType<typeof createAuth>;

// better-auth's D1 support auto-detects the binding (D1SqliteDialect via the
// batch/exec/prepare shape), but the binding only exists inside a request —
// so this is a per-request factory, never a module-scope instance.
export function createAuth(env: Env) {
  return betterAuth({
    baseURL: env.PUBLIC_BASE_URL,
    basePath: "/api/auth",
    secret: env.BETTER_AUTH_SECRET || undefined,
    database: env.DB,
    plugins: [
      // Roles live on user.role: "admin" | "reviewer" | "submitter" (default
      // for magic-link sign-ups). Reviewers are promoted via
      // scripts/promote-admin.ts; admins via the admin endpoints or the same
      // script.
      admin({ defaultRole: "submitter" }),
      magicLink({
        sendMagicLink: async ({ email, url }) => {
          if (!env.RESEND_API_KEY) {
            // Dev/test: no mailer configured — log the link so sign-in flows
            // remain usable locally.
            console.log(`[auth] magic link for ${email}: ${url}`);
            return;
          }
          await sendEmail(
            env,
            email,
            "Your Laparku sign-in link",
            `<p><a href="${url}">Sign in to Laparku</a></p><p>This link expires shortly and can only be used once.</p>`,
          );
        },
      }),
      // Needed for Task 11's MCP submit_menu (x-api-key auth).
      apiKey(),
    ],
  });
}
