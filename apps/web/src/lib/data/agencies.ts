/*
 * Agency registry — fetches the list of supported transit agencies from
 * neary-gtfs. The registry lives in the `releases` branch and is CORS-open
 * via raw.githubusercontent.com, so no proxy needed.
 *
 * The neary-gtfs README documents two URL variants per agency:
 *   agency_url   (string)         — most agencies
 *   agency_urls  (string[])       — agencies with multiple official sites
 * We normalize to a single `url` field (first available).
 */

const REGISTRY_URL = 'https://raw.githubusercontent.com/ciotlosm/neary-gtfs/releases/data/agency.json';

export interface Agency {
  id: number;
  name: string;
  url: string | null;
  timezone: string;
  lang: string | null;
  /** Whether a SQLite blob exists for this agency right now. */
  hasSqlite: boolean;
}

interface RawAgency {
  agency_id: number;
  agency_name: string;
  agency_url?: string | null;
  agency_urls?: string[] | null;
  agency_timezone: string;
  agency_lang?: string | null;
}

// Agencies for which neary-gtfs currently publishes a `.sqlite3.gz` blob. As
// the pipeline adds more agencies, expand this set. Until an agency is in
// here, the picker shows the agency but disables selection.
//
// Phase 2 local-only: agency 2 (CTP Cluj) has a locally-generated SQLite at
// apps/web/static/dev-data/. Others 404 — UI surfaces that gracefully.
const AGENCIES_WITH_SQLITE = new Set<number>([2]);

/** Fetch and normalize the agency registry. */
export async function fetchAgencies(): Promise<Agency[]> {
  const res = await fetch(REGISTRY_URL);
  if (!res.ok) throw new Error(`Agency registry fetch failed (${res.status})`);
  const raw = (await res.json()) as RawAgency[];
  return raw
    .map((a) => ({
      id: a.agency_id,
      name: a.agency_name.replace(/\s+/g, ' ').trim(),
      url: a.agency_url ?? (a.agency_urls && a.agency_urls.length > 0 ? a.agency_urls[0] : null),
      timezone: a.agency_timezone,
      lang: a.agency_lang ?? null,
      hasSqlite: AGENCIES_WITH_SQLITE.has(a.agency_id),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
