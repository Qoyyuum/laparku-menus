import { sql } from "drizzle-orm";
import { getDb } from "../db/client";
import type { Submission } from "../db/schema";
import type { Env } from "../env";

// Shared sender — magic links (src/auth.ts) and contributor notifications
// both go through here so from-address handling and the missing-binding
// behavior stay in one place. Sends via the Cloudflare Email Service
// send_email binding (no API key; throws a coded Error on rejection).
// No-ops with a log line when EMAIL is unbound so dev/test flows stay
// usable without a mailer.
export async function sendEmail(env: Env, to: string, subject: string, html: string): Promise<void> {
  if (!env.EMAIL) {
    console.log(`[email] EMAIL binding unset — skipping "${subject}" to ${to}`);
    return;
  }
  await env.EMAIL.send({
    to,
    from: parseSender(env.AUTH_EMAIL_FROM || "Laparku <no-reply@laparku.com>"),
    subject,
    html,
    text: htmlToText(html),
  });
}

// AUTH_EMAIL_FROM accepts a bare address or "Name <addr@dom>"; the builder
// wants the display name split out into { email, name }.
function parseSender(from: string): string | EmailAddress {
  const m = /^(.*)<([^<>]+)>$/.exec(from.trim());
  if (!m) return from.trim();
  const name = m[1]!.trim();
  return name ? { name, email: m[2]!.trim() } : m[2]!.trim();
}

// Plain-text companion for the HTML bodies — Email Sending accepts both
// parts, and text-only clients (plus spam scoring) do better with one.
// Anchors keep their href inline so links (magic links especially) survive
// the strip.
function htmlToText(html: string): string {
  return html
    .replace(/<a\s[^>]*?href="([^"]*)"[^>]*>(.*?)<\/a>/gis, "$2 — $1")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

// "Your submission is live" email, fired once per successful approve (the
// caller — publishSubmission — only reaches it after the publish commits;
// the rollback path rethrows before this runs, and rejects never call it).
// The submitter's address comes off submissions.user_id → the better-auth
// `user` table (untracked by drizzle, hence raw SQL — same convention as
// leaderboards.ts); the venue the publish landed on rides along via the
// venue_revisions audit row so the email can name + link it.
//
// Best-effort: a missing user row (grandfathered anonymous submission), an
// unbound EMAIL binding, or an Email Service outage never propagates — the
// menu is already published and a mailer hiccup must not fail the approve.
export async function notifyPublished(env: Env, submission: Submission): Promise<void> {
  try {
    if (!submission.user_id) return;
    const [row] = (await getDb(env).all(sql`
      SELECT u.email AS email, v.id AS venue_id, v.name AS venue_name
      FROM "user" AS u
      LEFT JOIN venue_revisions AS r ON r.submission_id = ${submission.id}
      LEFT JOIN venues AS v ON v.id = r.venue_id
      WHERE u.id = ${submission.user_id}
      LIMIT 1
    `)) as { email: string; venue_id: string | null; venue_name: string | null }[];
    if (!row?.email) return;

    const venueBit = row.venue_name ? ` for <strong>${escapeHtml(row.venue_name)}</strong>` : "";
    const link = row.venue_id ? `${env.PUBLIC_BASE_URL}/venue/${row.venue_id}` : env.PUBLIC_BASE_URL;
    await sendEmail(
      env,
      row.email,
      "Your menu submission is live on Laparku",
      `<p>Good news — the menu you submitted${venueBit} is now live on Laparku.</p>` +
        `<p><a href="${escapeHtml(link)}">See it on Laparku</a></p>` +
        `<p>Thanks for contributing!</p>`,
    );
  } catch (e) {
    console.log(`[notify] publish email for submission ${submission.id} failed: ${e}`);
  }
}

// "Something you scanned was unpublished" email, fired when a reviewer
// removes a trusted-published item from the verify queue. Spec §6 calls
// for an email here (unlike a normal pending_review rejection, which sends
// no email — the submitter never saw their item go live).
// Same best-effort contract as notifyPublished: the item is already
// hidden, a mailer hiccup must not fail the unpublish.
export async function notifyUnpublished(
  env: Env,
  submission: Submission,
  itemName: string,
  venueName: string | null,
): Promise<void> {
  try {
    if (!submission.user_id) return;
    const [row] = (await getDb(env).all(sql`
      SELECT u.email AS email FROM "user" AS u WHERE u.id = ${submission.user_id} LIMIT 1
    `)) as { email: string }[];
    if (!row?.email) return;

    const venueBit = venueName ? ` at <strong>${escapeHtml(venueName)}</strong>` : "";
    await sendEmail(
      env,
      row.email,
      "An item you scanned was unpublished on Laparku",
      `<p>A reviewer removed <strong>${escapeHtml(itemName)}</strong>${venueBit} — ` +
        `it didn't hold up to the double-check.</p>` +
        `<p>If this looks wrong, resubmit with a clearer photo of the product.</p>`,
    );
  } catch (e) {
    console.log(`[notify] unpublish email for submission ${submission.id} failed: ${e}`);
  }
}

// "Trusted items went live" heads-up to every reviewer/admin (spec §6).
// Trusted publishes skip the review queue, so without this email the
// pending-verification tab could sit unseen. Recipients come off the
// better-auth `user` table (untracked by drizzle → raw SQL, same convention
// as the submitter lookups above); roles are comma-separated there, so
// they're split and matched in JS — the same check requireAuth applies —
// rather than a LIKE that could substring-match an unrelated role name.
// Best-effort like the other notifications — an Email Service outage never
// blocks a publish.
export async function notifyTrustedPublish(env: Env, venueName: string, count: number): Promise<void> {
  try {
    const rows = (await getDb(env).all(sql`
      SELECT email, role FROM "user" WHERE banned IS NULL OR banned = 0
    `)) as { email: string; role: string | null }[];
    const recipients = rows
      .filter((r) =>
        (r.role ?? "submitter")
          .split(",")
          .some((role) => role === "reviewer" || role === "admin"),
      )
      .map((r) => r.email)
      .filter((e) => typeof e === "string" && e !== "");
    const subject = `${count} product${count === 1 ? "" : "s"} trusted-published at ${venueName} — pending verification`;
    const html =
      `<p>${count} scanned product${count === 1 ? "" : "s"} just went live ` +
      `at <strong>${escapeHtml(venueName)}</strong> through the trusted-publish path.</p>` +
      `<p>They carry the pending-verification badge until a reviewer confirms them.</p>` +
      `<p><a href="${escapeHtml(`${env.PUBLIC_BASE_URL}/admin`)}">Open the verify queue</a></p>`;
    for (const email of recipients) {
      try {
        await sendEmail(env, email, subject, html);
      } catch (e) {
        // One bad recipient/send must not starve the rest of the list.
        console.log(`[notify] reviewer notice to ${email} failed: ${e}`);
      }
    }
  } catch (e) {
    console.log(`[notify] reviewer notice for ${venueName} failed: ${e}`);
  }
}
