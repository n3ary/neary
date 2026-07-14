/*
 * Feed registry — fetches the app-facing feeds.json catalog from gtfs.
 * The registry is published nightly to the `binaries` branch and fetched
 * via `raw.githubusercontent.com` (CORS-open, ~5-min edge cache).
 *
 * Each entry is one publishable transit feed. Where the underlying GTFS
 * zip came from is recorded in `source` but is otherwise an implementation
 * detail of gtfs — the app only consumes `files.sqlite_gz`.
 *
 * Source contract: https://github.com/n3ary/gtfs (schema at
 * schemas/feeds.schema.json).
 */

export const FEEDS_REGISTRY_URL =
  'https://gtfs.n3ary.com/feeds.json';

export interface Feed {
  /** Stable slug — what the app picks and persists in userPrefs.feedId. */
  id: string;
  /** Human-facing display name (from Transitous source). */
  name: string;
  /** ISO 3166-1 alpha-2. */
  country: string;
  region?: string;
  /** IANA tz, derived from agency.txt of the built zip. */
  timezone: string;
  languages?: string[];
  bbox: { minLat: number; minLon: number; maxLat: number; maxLon: number };
  center: { lat: number; lon: number };
  agencies: Array<{
    agency_id: string | null;
    agency_name: string;
    agency_url: string | null;
  }>;
  source: {
    type: 'transitous' | 'mobility-database' | 'remote' | 'adapter';
    publisher: string;
    upstream_url?: string | null;
    /** Set by gtfs build-all.js for change-detection (HEAD ETag match ⇒ skip rebuild). */
    upstream_etag?: string | null;
  };
  files: {
    sqlite_gz: string | null;
    /** Content-addressed GTFS Schedule .zip artifact. New in feeds.json
     *  schema 2026-07 — every adapter-driven feed (and any feed opted
     *  into the upstream-zip R2 publish) gets one. The app doesn't
     *  consume the zip directly, but `bootstrap.ts` may opportunistically
     *  expose it for debugging. */
    gtfs_zip: string | null;
  };
  size_bytes: {
    sqlite_gz: number | null;
    gtfs_zip: number | null;
  };
  /** sha256-... of sqlite_gz (the file the app actually downloads). */
  hash: string;
  generated_at: string;
  valid_from?: string | null;
  valid_until?: string | null;
  realtime?: {
    /** URL the app calls for cleaned vehicle_positions. In production
     *  this is the canonical gtfs-rt.n3ary.com proxy URL (the static
     *  pipeline rewrites it whenever the feed has a feeds/<id>/config.json).
     *  null/undefined when the feed has no realtime configured. */
    vehicle_positions?: string;
    /** URL the gtfs-rt server polls (i.e. the operator's upstream).
     *  App code does NOT use this -- it's for the server-side proxy.
     *  Documented here so the consumer of this type knows it exists
     *  and can ignore it. */
    upstream_vehicle_positions?: string;
    extra_vehicle_positions?: string[];
    trip_updates?: string;
    service_alerts?: string;
  } | null;
  license: {
    spdx_identifier?: string | null;
    attribution_text: string;
    attribution_url?: string | null;
  };
  /** Optional link to the operator's ticket-purchase surface (e.g. 24pay,
   *  web shop). The app surfaces this on station views when set. */
  buyTicketUrl?: string;
}

export interface FeedsRegistry {
  version: string;
  generated_at: string;
  feeds: Feed[];
}

/**
 * Fetch and parse the live registry. Throws on network/parse failure.
 *
 * `cache: 'no-cache'` forces the browser to revalidate with the
 * server (`If-None-Match` on the ETag) instead of silently serving a
 * cached copy for the full max-age window (~5 min on raw.githubusercontent.com).
 * Cheap when the registry hasn't changed (304, no body), and the
 * latency only matters on cold loads anyway. The in-memory store on
 * top is what makes repeat reads free — see `feedsStore`.
 */
export async function fetchFeeds(): Promise<Feed[]> {
  const res = await fetch(FEEDS_REGISTRY_URL, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Feed registry fetch failed (${res.status})`);
  const reg = (await res.json()) as FeedsRegistry;
  return reg.feeds;
}
