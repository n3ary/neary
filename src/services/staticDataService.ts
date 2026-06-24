/**
 * Static Data Service
 *
 * Fetches transit static data (routes, stops, trips, stop_times, shapes) from
 * the neary-gtfs releases branch on GitHub. This avoids hitting the Tranzy API
 * for data that only changes once per day, saving API quota and eliminating the
 * need for end-users to have a Tranzy API key for static data.
 *
 * Hash-based freshness: before downloading a full payload, we fetch the hash
 * manifest and compare against the locally stored hash. If unchanged, we skip
 * the download entirely.
 */

import type { StaticEndpoint } from '../utils/schedule/agencyFeeds';
import { staticDataUrl, hashManifestUrl } from '../utils/schedule/agencyFeeds';

const LOG_PREFIX = '[StaticDataService]';

/** Locally stored hashes, keyed by "<agencyId>/<endpoint>". */
const HASH_STORAGE_KEY = 'static-data-hashes';
/** Locally stored timestamps for freshness display. */
const TIMESTAMPS_STORAGE_KEY = 'static-data-timestamps';

interface EndpointTimestamps {
  lastChecked: number | null;
  lastChanged: number | null;
}

function getStoredHashes(): Record<string, string> {
  try {
    const raw = localStorage.getItem(HASH_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function setStoredHash(key: string, hash: string): void {
  try {
    const hashes = getStoredHashes();
    hashes[key] = hash;
    localStorage.setItem(HASH_STORAGE_KEY, JSON.stringify(hashes));
  } catch {
    // localStorage full or unavailable — non-fatal
  }
}

function getStoredTimestamps(): Record<string, EndpointTimestamps> {
  try {
    const raw = localStorage.getItem(TIMESTAMPS_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function updateTimestamp(key: string, changed: boolean): void {
  try {
    const all = getStoredTimestamps();
    const now = Date.now();
    const existing = all[key] || { lastChecked: null, lastChanged: null };
    all[key] = {
      lastChecked: now,
      lastChanged: changed ? now : existing.lastChanged,
    };
    localStorage.setItem(TIMESTAMPS_STORAGE_KEY, JSON.stringify(all));
  } catch {
    // non-fatal
  }
}

/**
 * Fetch the remote hash manifest from the releases branch.
 * Returns a map of "<agencyId>/<endpoint>" → sha256 hash.
 */
async function fetchRemoteHashes(): Promise<Record<string, string>> {
  try {
    const res = await fetch(hashManifestUrl(), {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return {};
    return await res.json();
  } catch {
    return {};
  }
}

export interface StaticDataResult<T> {
  data: T;
  hash: string;
  fromCache: boolean;
}

/**
 * Fetch a static data endpoint for an agency.
 *
 * 1. Checks remote hash manifest against locally stored hash.
 * 2. If hash unchanged → returns null (caller should use cached data).
 * 3. If hash changed or no local hash → downloads the full payload.
 *
 * @returns The data + new hash, or null if data hasn't changed.
 */
async function fetchEndpoint<T>(
  agencyId: number,
  endpoint: StaticEndpoint,
  remoteHashes: Record<string, string>,
): Promise<StaticDataResult<T> | null> {
  const hashKey = `${agencyId}/${endpoint}`;
  const remoteHash = remoteHashes[hashKey];
  const localHash = getStoredHashes()[hashKey];

  // If we have a remote hash and it matches local → skip download
  if (remoteHash && remoteHash === localHash) {
    console.log(`${LOG_PREFIX} ${endpoint}: unchanged (hash match)`);
    updateTimestamp(hashKey, false);
    return null;
  }

  // Download the full payload
  const url = staticDataUrl(agencyId, endpoint);
  console.log(`${LOG_PREFIX} ${endpoint}: downloading from ${url}`);

  const res = await fetch(url, {
    signal: AbortSignal.timeout(60000), // 60s for shapes
  });

  if (!res.ok) {
    throw new Error(`${endpoint}: HTTP ${res.status}`);
  }

  const data = await res.json() as T;

  // Store the hash for next time
  const newHash = remoteHash || hashKey; // Use remote hash if available
  setStoredHash(hashKey, newHash);
  updateTimestamp(hashKey, true);

  return { data, hash: newHash, fromCache: false };
}

export const staticDataService = {
  /**
   * Fetch the hash manifest (lightweight — just a small JSON).
   * Call this first to determine which endpoints need updating.
   */
  fetchRemoteHashes,

  /**
   * Check if a specific endpoint has changed since last fetch.
   */
  hasChanged(agencyId: number, endpoint: StaticEndpoint, remoteHashes: Record<string, string>): boolean {
    const hashKey = `${agencyId}/${endpoint}`;
    const remoteHash = remoteHashes[hashKey];
    const localHash = getStoredHashes()[hashKey];
    // Changed if: no local hash, no remote hash (can't verify), or mismatch
    if (!remoteHash) return true; // Can't verify — assume changed
    return remoteHash !== localHash;
  },

  /**
   * Fetch a static endpoint, skipping download if hash hasn't changed.
   */
  fetchEndpoint,

  /**
   * Update the stored hash for an endpoint (call after successfully caching data).
   */
  markFresh(agencyId: number, endpoint: StaticEndpoint, remoteHashes: Record<string, string>): void {
    const hashKey = `${agencyId}/${endpoint}`;
    const remoteHash = remoteHashes[hashKey];
    if (remoteHash) {
      setStoredHash(hashKey, remoteHash);
    }
  },

  /**
   * Get freshness timestamps for all tracked endpoints.
   * Used by the Settings UI to show last-checked / last-changed.
   */
  getTimestamps(): Record<string, EndpointTimestamps> {
    return getStoredTimestamps();
  },

  /**
   * Get timestamps for a specific endpoint.
   */
  getEndpointTimestamps(agencyId: number, endpoint: StaticEndpoint): EndpointTimestamps {
    const key = `${agencyId}/${endpoint}`;
    return getStoredTimestamps()[key] || { lastChecked: null, lastChanged: null };
  },
};
