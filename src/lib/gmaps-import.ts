// Queue-side orchestration for gmaps_link submissions. Called from
// processSubmission when a gmaps_link row has no image_keys yet — the
// provider chain fetches the place's Menu-tab data, then one of three
// outcomes settles the row: trusted publish (structured menu + confident
// venue match), pending_review (structured menu, venue ambiguous/none, or
// nothing usable), or "photos" — downloaded photo payloads fall through to
// the normal vision pipeline.

import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { submissions, venues, type Submission } from "../db/schema";
import type { Env } from "../env";
import { downloadPhotos, fetchPlaceData, type GmapsPlaceData } from "./gmaps-provider";
import { trustedPublishGmaps, flattenSections } from "./gmaps-publish";
import type { GmapsResolved } from "./gmaps";
import { similarName, venuesNear } from "./venue-match";

// Auto-match radius — same 50 m as the venue-create dedup.
const AUTO_MATCH_M = 50;
// Candidate listing radius for the user's/reviewer's pick list.
const CANDIDATE_M = 200;
// Same-place imports inside this window get flagged as probable repeats
// (still processed — a re-import is a freshness refresh for trusted
// publish; the flag only informs reviewers).
const RECENT_DUP_DAYS = 14;

export type GmapsImportOutcome = "settled" | "photos";

function venueTypeFromCategories(categories?: string[]): string {
  const c = (categories ?? []).join(" ").toLowerCase();
  if (/supermarket|hypermarket/.test(c)) return "supermarket";
  if (/grocery|grocer|mini.?mart/.test(c)) return "grocer";
  if (/convenience|7-eleven|minimart/.test(c)) return "convenience";
  return "restaurant";
}

function resolvedFromRow(sub: Submission): GmapsResolved {
  const g = sub.raw_extraction?.gmaps ?? {};
  return {
    resolved_url: g.resolved_url ?? sub.provenance,
    ...(g.place_id ? { place_id: g.place_id } : {}),
    ...(g.data_id ? { data_id: g.data_id } : {}),
    ...(g.place?.name ? { name: g.place.name } : {}),
    ...(g.place?.lat !== undefined && g.place?.lng !== undefined
      ? { lat: g.place.lat, lng: g.place.lng }
      : {}),
  };
}

// Flag a same-place import inside RECENT_DUP_DAYS (informational only).
async function flagRecentDup(db: Db, sub: Submission, flags: Set<string>): Promise<void> {
  const placeId = sub.raw_extraction?.gmaps?.place_id;
  if (!placeId) return;
  const cutoff = Date.now() - RECENT_DUP_DAYS * 86_400_000;
  const rows = await db
    .select({ id: submissions.id })
    .from(submissions)
    .where(
      sql`${submissions.id} != ${sub.id}
        AND ${submissions.source_type} = 'gmaps_link'
        AND ${submissions.created_at} >= ${cutoff}
        AND json_extract(${submissions.raw_extraction}, '$.gmaps.place_id') = ${placeId}`,
    )
    .limit(1);
  if (rows.length > 0) flags.add("gmaps_recent_dup");
}

/**
 * Fetch + settle a gmaps_link submission. Returns "settled" when the row
 * reached a terminal/review state here, or "photos" when images were
 * downloaded to R2 and the caller should continue the normal pipeline.
 * Provider failures throw so the queue retry machinery handles them.
 */
export async function processGmapsImport(
  env: Env,
  db: Db,
  sub: Submission,
  flags: Set<string>,
): Promise<GmapsImportOutcome> {
  const resolved = resolvedFromRow(sub);
  const result = await fetchPlaceData(resolved, env);

  if (result.kind === "empty") {
    flags.add("gmaps_no_data");
    await db
      .update(submissions)
      .set({
        status: "auto_rejected",
        rejection_reason: "gmaps_no_data",
        auto_flags: [...flags],
      })
      .where(eq(submissions.id, sub.id));
    return "settled";
  }

  const data: GmapsPlaceData = result.data;
  const place = {
    name: data.place.name ?? resolved.name ?? undefined,
    address: data.place.address,
    lat: data.place.lat ?? resolved.lat,
    lng: data.place.lng ?? resolved.lng,
    categories: data.place.categories,
  };
  const venueGuess = place.name
    ? { name: place.name, type: venueTypeFromCategories(place.categories) }
    : null;

  await flagRecentDup(db, sub, flags);

  const gmapsCache = {
    resolved_url: resolved.resolved_url,
    place_id: resolved.place_id,
    data_id: resolved.data_id,
    provider: data.provider,
    place,
    sections: data.sections,
    photo_urls: data.photo_urls,
  };

  // Structured menu — try a venue match for the trusted path.
  if (data.sections.length > 0) {
    const candidates: { id: string; name: string; distance_m: number }[] = [];
    let matchedVenueId: string | null = null;

    // Hard match: a venue already carries this Google place id.
    if (resolved.place_id) {
      const [byPid] = await db
        .select({ id: venues.id })
        .from(venues)
        .where(eq(venues.google_place_id, resolved.place_id))
        .limit(1);
      if (byPid) matchedVenueId = byPid.id;
    }

    // Soft match: same name within 50 m.
    if (!matchedVenueId && place.lat !== undefined && place.lng !== undefined && place.name) {
      const near = await venuesNear(db, { lat: place.lat, lng: place.lng, radius_m: CANDIDATE_M });
      candidates.push(
        ...near.map((c) => ({ id: c.venue.id, name: c.venue.name, distance_m: Math.round(c.distance_m) })),
      );
      const auto = near.find(
        (c) => c.distance_m <= AUTO_MATCH_M && similarName(c.venue.name, place.name!),
      );
      if (auto) matchedVenueId = auto.venue.id;
    }

    const userId = sub.user_id;
    if (matchedVenueId && userId) {
      await trustedPublishGmaps(
        db,
        {
          userId,
          venueId: matchedVenueId,
          submissionId: sub.id,
          sections: data.sections,
          googlePlaceId: resolved.place_id,
        },
        env,
      );
      return "settled";
    }

    // No confident match — reviewer (or the user via the attach endpoint)
    // picks the venue. Everything needed is cached on the row.
    flags.add(candidates.length > 0 ? "venue_ambiguous" : "venue_unverified");
    await db
      .update(submissions)
      .set({
        status: "pending_review",
        auto_flags: [...flags],
        raw_extraction: {
          venue_guess: venueGuess,
          items: flattenSections(data.sections),
          gmaps: { ...gmapsCache, venue_candidates: candidates },
        },
      })
      .where(eq(submissions.id, sub.id));
    return "settled";
  }

  // Photo fallback — pull images and let the vision pipeline read them.
  const photos = await downloadPhotos(data.photo_urls);
  if (photos.length === 0) {
    // Provider said "ok" but delivered nothing usable — settle rather
    // than retrying what won't change.
    flags.add("gmaps_no_data");
    await db
      .update(submissions)
      .set({
        status: "auto_rejected",
        rejection_reason: "gmaps_no_data",
        auto_flags: [...flags],
      })
      .where(eq(submissions.id, sub.id));
    return "settled";
  }

  const imageKeys: string[] = [];
  for (const [i, photo] of photos.entries()) {
    const key = `submissions/${sub.id}/${i}`;
    await env.SUBMISSIONS.put(key, photo.bytes, { httpMetadata: { contentType: photo.mime } });
    imageKeys.push(key);
  }
  await db
    .update(submissions)
    .set({
      image_keys: imageKeys,
      auto_flags: [...flags],
      raw_extraction: { venue_guess: venueGuess, gmaps: gmapsCache },
    })
    .where(eq(submissions.id, sub.id));
  return "photos";
}
