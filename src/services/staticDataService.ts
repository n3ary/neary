/**
 * Static Data Service — single orchestrator for all static transit data.
 *
 * Fetches routes, stops, trips, stop_times, shapes from the neary-gtfs releases
 * branch on GitHub. One manifest check, parallel endpoint downloads, hash-based
 * skip when unchanged.
 *
 * Runs:
 * - On first app start (no cached data)
 * - Once per day (24h freshness)
 * - After localStorage clear
 *
 * Individual stores persist data in localStorage. This service only fetches when
 * the remote hash differs from what we last downloaded.
 */

import type { TranzyRouteResponse, TranzyStopResponse, TranzyTripResponse, TranzyStopTimeResponse, TranzyShapeResponse } from '../types/rawTranzyApi';
import type { StaticEndpoint } from '../utils/schedule/agencyFeeds';
import { staticDataUrl, hashManifestUrl } from '../utils/schedule/agencyFeeds';

const LOG_PREFIX = '[StaticData]';

// ============================================================================
// Local storage keys
// ============================================================================

const HASH_STORAGE_KEY = 'static-data-hashes';
const TIMESTAMPS_STORAGE_KEY = 'static-data-timestamps';
const LAST_SYNC_KEY = 'static-data-last-sync';

/** How often to check for updates (24 hours). */
const SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;

// ============================================================================
// Storage helpers
// ============================================================================

export interface EndpointTimestamps {
  lastChecked: number | null;
  lastChanged: number | null;
}

function getStoredHashes(): Record<string, string> {
  try {
    const raw = localStorage.getItem(HASH_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function setStoredHash(key: string, hash: string): void {
  try {
    const hashes = getStoredHashes();
    hashes[key] = hash;
    localStorage.setItem(HASH_STORAGE_KEY, JSON.stringify(hashes));
  } catch { /* non-fatal */ }
}

function getStoredTimestamps(): Record<string, EndpointTimestamps> {
  try {
    const raw = localStorage.getItem(TIMESTAMPS_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function updateTimestamp(key: string, changed: boolean, serverSyncedAt: string | null): void {
  try {
    const all = getStoredTimestamps();
    const now = Date.now();
    const existing = all[key] || { lastChecked: null, lastChanged: null };
    const serverTime = serverSyncedAt ? Date.parse(serverSyncedAt) : null;
    
    let lastChanged = existing.lastChanged;
    if (changed) {
      // Data was freshly downloaded — use server time if available, otherwise now
      lastChanged = (serverTime && Number.isFinite(serverTime)) ? serverTime : now;
    } else if (!lastChanged && serverTime && Number.isFinite(serverTime)) {
      // Hash matched but we never recorded a lastChanged — backfill from server
      lastChanged = serverTime;
    }

    all[key] = { lastChecked: now, lastChanged };
    localStorage.setItem(TIMESTAMPS_STORAGE_KEY, JSON.stringify(all));
  } catch { /* non-fatal */ }
}

function getLastSyncTime(): number {
  try {
    return Number(localStorage.getItem(LAST_SYNC_KEY)) || 0;
  } catch { return 0; }
}

function setLastSyncTime(): void {
  try {
    localStorage.setItem(LAST_SYNC_KEY, String(Date.now()));
  } catch { /* non-fatal */ }
}

// ============================================================================
// Manifest fetch (cached per session to avoid redundant network calls)
// ============================================================================

let cachedManifest: { syncedAt: string | null; hashes: Record<string, string> } | null = null;
let manifestFetchPromise: Promise<{ syncedAt: string | null; hashes: Record<string, string> }> | null = null;

async function fetchManifest(): Promise<{ syncedAt: string | null; hashes: Record<string, string> }> {
  // Return cached manifest if already fetched this session
  if (cachedManifest) return cachedManifest;

  // Deduplicate concurrent calls
  if (manifestFetchPromise) return manifestFetchPromise;

  manifestFetchPromise = (async () => {
    try {
      const res = await fetch(hashManifestUrl(), { signal: AbortSignal.timeout(10000) });
      if (!res.ok) return { syncedAt: null, hashes: {} };
      const data = await res.json();
      if (data && typeof data === 'object' && 'hashes' in data) {
        cachedManifest = { syncedAt: data.syncedAt || null, hashes: data.hashes };
      } else {
        cachedManifest = { syncedAt: null, hashes: data };
      }
      return cachedManifest!;
    } catch {
      return { syncedAt: null, hashes: {} };
    } finally {
      manifestFetchPromise = null;
    }
  })();

  return manifestFetchPromise;
}

// ============================================================================
// Single endpoint fetch
// ============================================================================

async function fetchSingleEndpoint<T>(
  agencyId: number,
  endpoint: StaticEndpoint,
  hashes: Record<string, string>,
  syncedAt: string | null,
): Promise<{ endpoint: StaticEndpoint; data: T | null; changed: boolean }> {
  const hashKey = `${agencyId}/${endpoint}`;
  const remoteHash = hashes[hashKey];
  const localHash = getStoredHashes()[hashKey];

  if (remoteHash && remoteHash === localHash) {
    updateTimestamp(hashKey, false, syncedAt);
    return { endpoint, data: null, changed: false };
  }

  const url = staticDataUrl(agencyId, endpoint);
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`${endpoint}: HTTP ${res.status}`);

  const data = await res.json() as T;
  const newHash = remoteHash || hashKey;
  setStoredHash(hashKey, newHash);
  updateTimestamp(hashKey, true, syncedAt);

  return { endpoint, data, changed: true };
}

// ============================================================================
// Sync result interface
// ============================================================================

export interface SyncResult {
  routes: TranzyRouteResponse[] | null;
  stops: TranzyStopResponse[] | null;
  trips: TranzyTripResponse[] | null;
  stop_times: TranzyStopTimeResponse[] | null;
  shapes: TranzyShapeResponse[] | null;
  /** Endpoints that were actually downloaded (not hash-matched). */
  changed: StaticEndpoint[];
  /** Endpoints that were skipped (hash matched). */
  unchanged: StaticEndpoint[];
  /** Endpoints that failed. */
  failed: StaticEndpoint[];
}

// ============================================================================
// Progress callback
// ============================================================================

export type SyncProgressCallback = (status: {
  endpoint: StaticEndpoint;
  state: 'checking' | 'downloading' | 'done' | 'unchanged' | 'failed';
}) => void;

// ============================================================================
// Public API
// ============================================================================

export const staticDataService = {
  /**
   * Whether a sync is needed (first run, stale, or storage cleared).
   */
  needsSync(agencyId: number): boolean {
    const lastSync = getLastSyncTime();
    if (!lastSync) return true;
    if (Date.now() - lastSync > SYNC_INTERVAL_MS) return true;
    const hashes = getStoredHashes();
    const endpoints: StaticEndpoint[] = ['routes', 'stops', 'trips', 'stop_times', 'shapes'];
    return endpoints.some(ep => !hashes[`${agencyId}/${ep}`]);
  },

  /**
   * Fetch a single endpoint (used by individual services).
   * Shares the cached manifest — only one network call for the manifest per session.
   */
  async fetchEndpoint<T>(agencyId: number, endpoint: StaticEndpoint): Promise<T | null> {
    const { syncedAt, hashes } = await fetchManifest();
    const result = await fetchSingleEndpoint<T>(agencyId, endpoint, hashes, syncedAt);
    return result.data;
  },

  /**
   * Sync all static data for an agency in parallel.
   */
  async syncAll(agencyId: number, onProgress?: SyncProgressCallback): Promise<SyncResult> {
    console.log(`${LOG_PREFIX} Starting sync for agency ${agencyId}...`);

    const { syncedAt, hashes } = await fetchManifest();
    const endpoints: StaticEndpoint[] = ['routes', 'stops', 'trips', 'stop_times', 'shapes'];

    const result: SyncResult = {
      routes: null, stops: null, trips: null, stop_times: null, shapes: null,
      changed: [], unchanged: [], failed: [],
    };

    // Fetch all endpoints in parallel
    const promises = endpoints.map(async (ep) => {
      onProgress?.({ endpoint: ep, state: 'checking' });
      try {
        const r = await fetchSingleEndpoint(agencyId, ep, hashes, syncedAt);
        if (r.changed) {
          onProgress?.({ endpoint: ep, state: 'done' });
          result.changed.push(ep);
        } else {
          onProgress?.({ endpoint: ep, state: 'unchanged' });
          result.unchanged.push(ep);
        }
        return { ep, data: r.data };
      } catch (err) {
        console.warn(`${LOG_PREFIX} Failed to fetch ${ep}:`, err);
        onProgress?.({ endpoint: ep, state: 'failed' });
        result.failed.push(ep);
        return { ep, data: null };
      }
    });

    const results = await Promise.all(promises);

    for (const { ep, data } of results) {
      if (data !== null) {
        (result as any)[ep] = data;
      }
    }

    setLastSyncTime();
    console.log(`${LOG_PREFIX} Sync complete: ${result.changed.length} changed, ${result.unchanged.length} unchanged, ${result.failed.length} failed`);

    return result;
  },

  /**
   * Get freshness timestamps for all tracked endpoints.
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

  /**
   * Fetch manifest only (for callers that need hash checking without full sync).
   */
  fetchManifest,

  /**
   * Invalidate the cached manifest (call after storage clear or agency change).
   */
  invalidateCache(): void {
    cachedManifest = null;
    manifestFetchPromise = null;
  },
};
