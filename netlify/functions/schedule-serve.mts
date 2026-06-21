/**
 * GTFS Schedule Serving — Netlify function.
 *
 * Exposes a per-agency compact schedule payload (written daily to Netlify Blobs
 * by the pipeline) at the public CDN URL `/data/schedule/<agencyId>.json`, which
 * the client `scheduleStore` fetches for its active agency.
 *
 * Why this function exists:
 *   Netlify Blobs are reachable only through the `@netlify/blobs` SDK from a
 *   function/edge runtime — they have no built-in public HTTP URL. To serve a
 *   blob at a stable CDN path we (a) read the blob here and return it as JSON,
 *   and (b) rewrite `/data/schedule/*` → this function in netlify.toml.
 *
 * The agency id is parsed from the request path (e.g. `/data/schedule/2.json`)
 * and mapped to the blob key via the shared {@link scheduleBlobKey} helper, so
 * the key convention stays in sync with the writing pipeline.
 *
 * Caching: sets `Cache-Control: public, max-age=3600` (1-hour edge cache),
 * matching the netlify.toml `/data/*` rule; set here too because netlify.toml
 * headers are not reliably applied to function/rewrite responses.
 *
 * Design reference: .kiro/specs/gtfs-schedule-integration/design.md
 */

import { getStore } from '@netlify/blobs';
import {
  scheduleBlobKey,
  parseAgencyIdFromPath,
  hasScheduleForAgency,
} from '../../src/utils/schedule/agencyFeeds';
import { SCHEDULE_BLOB_STORE } from '../lib/schedulePipeline.mts';

/** One-hour CDN cache for the served payload. */
const CACHE_CONTROL = 'public, max-age=3600';

const LOG_PREFIX = '[ScheduleServe]';

function jsonError(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export default async function handler(request: Request): Promise<Response> {
  const agencyId = parseAgencyIdFromPath(new URL(request.url).pathname);

  if (agencyId === null) {
    return jsonError(400, 'Missing or invalid agency id in path');
  }

  // Reject agencies we do not publish, so the client gets a clear signal to
  // fall back to GPS-only rather than a generic 404 from a missing blob.
  if (!hasScheduleForAgency(agencyId)) {
    return jsonError(404, `No schedule published for agency ${agencyId}`);
  }

  try {
    const store = getStore(SCHEDULE_BLOB_STORE);

    // Stream the stored JSON straight through to keep memory flat for the
    // multi-hundred-KB payload.
    const stream = await store.get(scheduleBlobKey(agencyId), { type: 'stream' });

    if (!stream) {
      // Registered agency but no payload published yet (pipeline has not run or
      // its first run has not completed). Client treats this as a fetch failure
      // and falls back to GPS-only behavior.
      return jsonError(404, 'Schedule not available');
    }

    return new Response(stream, {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'cache-control': CACHE_CONTROL,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${LOG_PREFIX} failed to serve schedule blob for agency ${agencyId}:`, message);
    return jsonError(500, 'Failed to load schedule');
  }
}
