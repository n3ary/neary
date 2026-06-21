/**
 * Agency → GTFS feed registry.
 *
 * Single source of truth that maps a Tranzy `agency_id` (what the app stores in
 * `configStore.agency_id` and sends as the `X-Agency-Id` header) to its public
 * GTFS static feed. This is imported by BOTH the server pipeline/serve Netlify
 * functions (which fetch and publish per-agency schedule blobs) and the client
 * `scheduleStore` (which requests the schedule URL for the active agency), so
 * the blob key and CDN URL conventions never drift between the two sides.
 *
 * Adding another agency is a one-line registry entry: provide its Tranzy
 * `agencyId` and the public GTFS ZIP URL. No pipeline/serve/client code changes
 * are required — the daily pipeline starts publishing it and the client starts
 * requesting it automatically. Agencies without an entry simply have no
 * schedule layer; the app degrades to GPS-only for them.
 */

/** One agency's GTFS feed configuration. */
export interface AgencyFeed {
  /**
   * Tranzy agency_id — the SAME id the app uses for `configStore.agency_id` and
   * the `X-Agency-Id` Tranzy header. This is what links a published schedule
   * blob to the user's selected agency.
   */
  agencyId: number;
  /** Human-readable agency name (logs, docs, debugging only). */
  name: string;
  /** Public GTFS static ZIP feed URL. */
  feedUrl: string;
}

/**
 * Registered agency feeds.
 *
 * Verified Tranzy agency_ids (from the Tranzy `/agency` endpoint): SCTP Iasi=1,
 * CTP Cluj=2, RTEC&PUA Chisinau=4, Eltrans Botosani=6, OTL Oradea=9, CT BUS
 * Constanta=10. Only agencies with a confirmed public GTFS feed URL are listed
 * here; add more as their feeds are verified.
 */
export const AGENCY_FEEDS: readonly AgencyFeed[] = [
  {
    agencyId: 2,
    name: 'CTP Cluj',
    // Public Cluj GTFS static feed (CC-BY-SA-4.0).
    feedUrl: 'https://external.gtfs.ro/cluj/CLUJ.zip',
  },
];

/** Look up the feed config for a Tranzy agency_id, or undefined when none. */
export function getAgencyFeed(agencyId: number): AgencyFeed | undefined {
  return AGENCY_FEEDS.find((feed) => feed.agencyId === agencyId);
}

/** Whether a schedule layer is published for the given Tranzy agency_id. */
export function hasScheduleForAgency(agencyId: number | null | undefined): boolean {
  return agencyId != null && AGENCY_FEEDS.some((feed) => feed.agencyId === agencyId);
}

/**
 * Netlify Blobs key holding an agency's compact schedule payload.
 * MUST be used identically by the pipeline (write) and serve (read) functions.
 */
export function scheduleBlobKey(agencyId: number): string {
  return `agency-${agencyId}`;
}

/**
 * Public CDN URL the client fetches for an agency's schedule. Mapped to the
 * serve function by the `/data/schedule/*` rewrite in netlify.toml.
 */
export function scheduleUrlForAgency(agencyId: number): string {
  return `/data/schedule/${agencyId}.json`;
}

/**
 * Parse the agency_id out of a serve-function request path such as
 * `/data/schedule/2.json` or `/.netlify/functions/schedule-serve/2`. Returns
 * null when no positive integer agency id can be extracted.
 */
export function parseAgencyIdFromPath(pathname: string): number | null {
  // Accept either the public `/data/schedule/<id>.json` shape or a trailing
  // numeric path segment, tolerating an optional `.json` suffix.
  const match = pathname.match(/(\d+)(?:\.json)?\/?$/);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isInteger(id) && id > 0 ? id : null;
}
