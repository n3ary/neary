import type { Database } from '@sqlite.org/sqlite-wasm';
import type { Network } from '$lib/domain/types';
import { selectAll } from '../sqlHelpers';

/** Fallback for blobs built before network_color was added to the pipeline. */
const FALLBACK_COLOR = '#5B2D8E';

/** Networks from the feed. `color` is pre-computed by the neary-gtfs pipeline
 *  and stored in the `network_color` column — the app reads it verbatim.
 *  Old blobs without the column get a neutral fallback; no color math here. */
export function getNetworks(db: Database): Network[] {
  const tables = selectAll<{ name: string }>(
    db,
    `SELECT name FROM sqlite_master WHERE type='table' AND name='networks';`,
  );
  if (tables.length === 0) return [];

  // Probe for the pipeline-written color column (absent in older blobs).
  const hasColor = selectAll<{ name: string }>(
    db,
    `SELECT name FROM pragma_table_info('networks') WHERE name='network_color';`,
  ).length > 0;

  if (hasColor) {
    return selectAll<Network>(
      db,
      `SELECT network_id AS id, network_name AS name,
              '#' || COALESCE(network_color, '5B2D8E') AS color
       FROM networks ORDER BY network_id;`,
    );
  }

  const rows = selectAll<{ id: string; name: string }>(
    db,
    `SELECT network_id AS id, network_name AS name FROM networks ORDER BY network_id;`,
  );
  return rows.map((n) => ({ ...n, color: FALLBACK_COLOR }));
}
