/**
 * Agency → schedule feed registry.
 *
 * Single source of truth that maps a Tranzy `agency_id` to its schedule layer.
 * The `neary-gtfs` repo (https://github.com/ciotlosm/neary-gtfs) publishes a
 * compact schedule JSON per agency as a GitHub Release asset. This app fetches
 * it via a Netlify proxy rewrite (`/data/schedule/<id>.json` → GitHub).
 *
 * Adding another agency is a one-line registry entry: provide its Tranzy
 * `agencyId` and name. The neary-gtfs repo must also have a corresponding
 * `agencies/<id>/` directory and GitHub Action. Agencies without an entry
 * simply have no schedule layer; the app degrades to GPS-only for them.
 */

/** One agency's schedule feed configuration. */
export interface AgencyFeed {
  /**
   * Tranzy agency_id — the SAME id the app uses for `configStore.agency_id`
   * and the `X-Agency-Id` Tranzy header.
   */
  agencyId: number;
  /** Human-readable agency name (logs, docs, debugging only). */
  name: string;
}

/**
 * Registered agency feeds.
 *
 * Verified Tranzy agency_ids: SCTP Iasi=1, CTP Cluj=2, RTEC&PUA Chisinau=4,
 * Eltrans Botosani=6, OTL Oradea=9, CT BUS Constanta=10. Only agencies with a
 * published neary-gtfs schedule are listed here.
 */
export const AGENCY_FEEDS: readonly AgencyFeed[] = [
  { agencyId: 2, name: 'CTP Cluj' },
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
 * URL the client fetches for an agency's compact schedule JSON. Proxied by
 * Netlify to the neary-gtfs GitHub Release asset (solves CORS).
 */
export function scheduleUrlForAgency(agencyId: number): string {
  return `/data/schedule/${agencyId}.json`;
}
