/**
 * GTFS Schedule Pipeline — Netlify scheduled function (daily).
 *
 * Runs once per day to refresh every registered agency's schedule. For each
 * agency in the {@link AGENCY_FEEDS} registry it fetches the public GTFS static
 * feed, transforms it into a compact JSON payload, and stores the result in
 * Netlify Blobs (key `agency-<id>`) for CDN delivery via the serve function at
 * `/data/schedule/<id>.json`.
 *
 * The per-agency fetch/transform/persist logic lives in the shared, server-only
 * `netlify/lib/schedulePipeline.mts` so the manual HTTP trigger
 * (`schedule-pipeline-trigger.mts`) can reuse it. Each agency is independent:
 * one failure never blocks the others, and a failed agency keeps its previously
 * published blob (all-or-nothing per agency).
 *
 * Design reference: .kiro/specs/gtfs-schedule-integration/design.md
 */

import { runSchedulePipeline } from '../lib/schedulePipeline.mts';

/** Netlify scheduled function configuration — runs once per day. */
export const config = {
  schedule: '@daily',
};

export default async function handler(): Promise<Response> {
  const results = await runSchedulePipeline();
  const ok = results.every((r) => r.ok);

  return new Response(JSON.stringify({ ok, agencies: results }), {
    // 200 when every agency succeeded; 500 when any failed (its previous blob
    // is retained). Partial success is still reported per-agency in the body.
    status: ok ? 200 : 500,
    headers: { 'content-type': 'application/json' },
  });
}
