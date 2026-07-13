/*
 * Route tag queries — read the producer-extension `_route_tags` table
 * (cluj-napoca adapter, issue #25). Returns the full tag set
 * (id, label, priority) for the feed; consumers can index by id for
 * per-route lookup.
 *
 * Older feeds that pre-date the producer extension don't have the
 * `_route_tags` table — `getTags` probes `sqlite_master` once and
 * returns an empty array so callers degrade gracefully (no chip
 * rendering, no filter rows). The pipeline emits the table for any
 * adapter that declares a `producerExtensions` entry whose
 * `feedConfigKey` resolves to a list of rows.
 */

import type { Database } from '@sqlite.org/sqlite-wasm';
import type { RouteTag } from '$lib/domain/types';
import { selectAll } from '../sqlHelpers';

type Row = { tag_id: string; tag_label: string | null; priority: number | null };

function hasRouteTagsTable(db: Database): boolean {
  return selectAll<{ name: string }>(
    db,
    `SELECT name FROM sqlite_master WHERE type='table' AND name='_route_tags';`,
  ).length > 0;
}

/** All tags in the feed, sorted by priority ASCENDING. Empty array
 *  for feeds that don't ship the producer extension. */
export function getTags(db: Database): RouteTag[] {
  if (!hasRouteTagsTable(db)) return [];
  const rows = selectAll<Row>(
    db,
    `SELECT DISTINCT tag_id, tag_label, priority
     FROM _route_tags
     ORDER BY priority ASC, tag_id ASC;`,
  );
  return rows.map((r) => ({
    id: r.tag_id,
    name: r.tag_label ?? r.tag_id,
    priority: r.priority ?? 0,
  }));
}
