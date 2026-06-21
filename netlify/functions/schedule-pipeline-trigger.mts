/**
 * GTFS Schedule Pipeline — manual HTTP trigger.
 *
 * The daily pipeline (`schedule-pipeline.mts`) is a scheduled function and
 * cannot be invoked directly over HTTP. This thin companion runs the SAME
 * shared pipeline core on demand, so a fresh deploy can be seeded (or a refresh
 * forced) without waiting for the `@daily` run:
 *
 *   curl -X POST https://<site>/.netlify/functions/schedule-pipeline-trigger
 *
 * It runs every registered agency and returns a per-agency summary.
 */

import { runSchedulePipeline } from '../lib/schedulePipeline.mts';

export default async function handler(): Promise<Response> {
  const results = await runSchedulePipeline();
  const ok = results.every((r) => r.ok);

  return new Response(JSON.stringify({ ok, agencies: results }), {
    status: ok ? 200 : 500,
    headers: { 'content-type': 'application/json' },
  });
}
