import { sql } from "drizzle-orm";
import { getDb } from "../db/client";
import type { Submission } from "../db/schema";
import type { Env } from "../env";

// Shared Resend sender — magic links (src/auth.ts) and contributor
// notifications both go through here so from-address handling and the
// missing-key behavior stay in one place. Throws on a non-2xx Resend
// response; no-ops with a log line when RESEND_API_KEY is unset so dev/test
// flows stay usable without a mailer.
export async function sendEmail(env: Env, to: string, subject: string, html: string): Promise<void> {
  if (!env.RESEND_API_KEY) {
    console.log(`[email] RESEND_API_KEY unset — skipping "${subject}" to ${to}`);
    return;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: env.AUTH_EMAIL_FROM || "Laparku <no-reply@laparku.com>",
      to,
      subject,
      html,
    }),
  });
  if (!res.ok) {
    throw new Error(`Resend send failed: ${res.status} ${await res.text()}`);
  }
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
// unset RESEND_API_KEY, or a Resend outage never propagates — the menu is
// already published and a mailer hiccup must not fail the approve.
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
// removes a trusted-published item from the verify queue (spec §6 — the
// submitter hears the same way a rejected submission would). Same
// best-effort contract as notifyPublished: the item is already hidden, a
// mailer hiccup must not fail the unpublish.
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
// as the submitter lookups above); roles are comma-separated there, so a
// substring match covers e.g. "submitter,reviewer". Best-effort like the
// other notifications — a Resend outage never blocks a publish.
export async function notifyTrustedPublish(env: Env, venueName: string, count: number): Promise<void> {
  try {
    const rows = (await getDb(env).all(sql`
      SELECT email FROM "user"
      WHERE (role LIKE '%reviewer%' OR role LIKE '%admin%')
        AND (banned IS NULL OR banned = 0)
    `)) as { email: string }[];
    const subject = `${count} product${count === 1 ? "" : "s"} trusted-published at ${venueName} — pending verification`;
    const html =
      `<p>${count} scanned product${count === 1 ? "" : "s"} just went live ` +
      `at <strong>${escapeHtml(venueName)}</strong> through the trusted-publish path.</p>` +
      `<p>They carry the pending-verification badge until a reviewer confirms them.</p>` +
      `<p><a href="${escapeHtml(`${env.PUBLIC_BASE_URL}/admin`)}">Open the verify queue</a></p>`;
    for (const r of rows) {
      if (!r.email) continue;
      try {
        await sendEmail(env, r.email, subject, html);
      } catch (e) {
        // One bad recipient/send must not starve the rest of the list.
        console.log(`[notify] reviewer notice to ${r.email} failed: ${e}`);
      }
    }
  } catch (e) {
    console.log(`[notify] reviewer notice for ${venueName} failed: ${e}`);
  }
}
