/*
 * Feed registry — fetches the app-facing feeds.json catalog from neary-gtfs.
 * The registry is published nightly to the binaries branch and fronted by
 * jsDelivr (CORS-open, 12h CDN cache).
 *
 * Replaces the v1 `agencies.ts` / agency.json registry. Each entry is a
 * publishable transit feed: either a Transitous mirror (bucuresti-ilfov),
 * or a locally-enhanced build (cluj-napoca with daily CTP CSV scrape).
 *
 * Source contract: https://github.com/ciotlosm/neary-gtfs (schema at
 * schemas/feeds.schema.json).
 */

export const FEEDS_REGISTRY_URL =
  'https://raw.githubusercontent.com/ciotlosm/neary-gtfs/binaries/feeds.json';

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
    type: 'build' | 'transitous' | 'mobility-database';
    publisher: string;
    upstream_url?: string | null;
    /** Set by neary-gtfs build-all.js for mirror change-detection. */
    upstream_etag?: string | null;
    /** Set by neary-gtfs for locally-built feeds; sha256 of zip content. */
    content_hash?: string | null;
  };
  files: {
    /** Mirrors omit gtfs_zip — use source.upstream_url for the raw zip. */
    gtfs_zip: string | null;
    sqlite_gz: string | null;
  };
  size_bytes: {
    gtfs_zip: number | null;
    sqlite_gz: number | null;
  };
  /** sha256-... of sqlite_gz (the file the app actually downloads). */
  hash: string;
  generated_at: string;
  valid_from?: string | null;
  valid_until?: string | null;
  realtime?: {
    vehicle_positions?: string;
    trip_updates?: string;
    service_alerts?: string;
  } | null;
  /**
   * Optional — present only for feeds covered by Tranzy.ai. Mapping to
   * Tranzy's internal X-Agency-Id (NOT the same as GTFS agency_id; see
   * neary-gtfs verification). When userPrefs.apiKey is set and this is
   * present, the live worker will poll Tranzy as a second signal.
   */
  tranzy?: { agency_id: string };
  license: {
    spdx_identifier?: string | null;
    attribution_text: string;
    attribution_url?: string | null;
  };
}

export interface FeedsRegistry {
  version: string;
  generated_at: string;
  feeds: Feed[];
}

/** Fetch and parse the live registry. Throws on network/parse failure. */
export async function fetchFeeds(): Promise<Feed[]> {
  const res = await fetch(FEEDS_REGISTRY_URL);
  if (!res.ok) throw new Error(`Feed registry fetch failed (${res.status})`);
  const reg = (await res.json()) as FeedsRegistry;
  return reg.feeds;
}
