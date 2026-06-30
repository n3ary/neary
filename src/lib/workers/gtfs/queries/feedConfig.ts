import type { Database } from '@sqlite.org/sqlite-wasm';
import { selectAll } from '../sqlHelpers';

export interface FeedTimingConfig {
  speed_kmh: { peak: number; offpeak: number; night: number };
  peak_windows: Array<{ from: string; to: string }>;
  night_window: { from: string; to: string };
  dwell_sec: number;
}

export interface NearyFeedConfig {
  timing?: FeedTimingConfig;
}

/** Read per-feed config from the `_neary_config` table written by the
 *  neary-gtfs pipeline. Returns an empty object for older blobs that
 *  pre-date this table — callers should fall back to app-side defaults. */
export function getFeedConfig(db: Database): NearyFeedConfig {
  const tables = selectAll<{ name: string }>(
    db,
    `SELECT name FROM sqlite_master WHERE type='table' AND name='_neary_config';`,
  );
  if (tables.length === 0) return {};

  const rows = selectAll<{ key: string; value: string }>(
    db,
    `SELECT key, value FROM _neary_config;`,
  );
  const config: NearyFeedConfig = {};
  for (const row of rows) {
    if (row.key === 'timing') {
      try { config.timing = JSON.parse(row.value) as FeedTimingConfig; } catch { /* ignore */ }
    }
  }
  return config;
}
