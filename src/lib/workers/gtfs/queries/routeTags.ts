/*
 * Route tag queries — read the producer-extension `_route_tags` table
 * (cluj-napoca adapter, issue #25). Returns the full tag set
 * (id, label, priority, icon, color) for the feed; consumers can
 * index by id for per-route lookup.
 *
 * Older feeds that pre-date the producer extension don't have the
 * `_route_tags` table — `getTags` probes `sqlite_master` once and
 * returns an empty array so callers degrade gracefully (no chip
 * rendering, no filter rows). The pipeline emits the table for any
 * adapter that declares a `producerExtensions` entry whose
 * `feedConfigKey` resolves to a list of rows.
 *
 * The `icon` column is the lucide-svelte slug the chip renders
 * (e.g. `moon`, `map-pin`, `plane`, `music`, `zap`). Owned by the
 * adapter's `TAGS` declarations, NOT hardcoded in the app — the app
 * looks the slug up in a small `tagIcons` registry keyed by icon
 * name. Feeds built before the icon column was added have no `icon`
 * cells; `getTags` returns `icon: undefined` for those rows and the
 * consumer's registry falls back to a `Star` default.
 *
 * The `color` column is the 6-char uppercase hex (no leading `#`)
 * the chip renders as its background. Owned by the adapter (the
 * `TAGS` array in `routeCategory.ts`); hand-picked per the operator's
 * brand. Feeds built before the color column was added have no
 * `color` cells; `getTags` returns `color: undefined` and the
 * consumer's chip falls back to the default semantic color.
 * Foreground contrast is derived generically via `pickContrastingText`
 * (all 5 cluj hand-picked colors are dark enough for `#fff`), so the
 * consumer doesn't need per-tag fg overrides.
 */

import type { Database } from '@sqlite.org/sqlite-wasm';
import type { RouteTag } from '$lib/domain/types';
import { selectAll } from '../sqlHelpers';

type Row = {
  tag_id: string;
  tag_label: string | null;
  priority: number | null;
  icon: string | null;
  color: string | null;
};

function hasRouteTagsTable(db: Database): boolean {
  return selectAll<{ name: string }>(
    db,
    `SELECT name FROM sqlite_master WHERE type='table' AND name='_route_tags';`,
  ).length > 0;
}

/** Probe for the `icon` column on `_route_tags` so feeds built
 *  before the icon contract was added (no `icon` cell) degrade
 *  gracefully instead of throwing `no such column: icon`. */
function hasIconColumn(db: Database): boolean {
  return selectAll<{ name: string }>(
    db,
    `SELECT name FROM pragma_table_info('_route_tags') WHERE name='icon';`,
  ).length > 0;
}

/** Probe for the `color` column on `_route_tags` (gtfs-adapters#156)
 *  so feeds built before the color contract was added (no `color`
 *  cell) degrade gracefully instead of throwing
 *  `no such column: color`. */
function hasColorColumn(db: Database): boolean {
  return selectAll<{ name: string }>(
    db,
    `SELECT name FROM pragma_table_info('_route_tags') WHERE name='color';`,
  ).length > 0;
}

/** All tags in the feed, sorted by priority ASCENDING. Empty array
 *  for feeds that don't ship the producer extension. */
export function getTags(db: Database): RouteTag[] {
  if (!hasRouteTagsTable(db)) return [];
  const withIcon = hasIconColumn(db);
  const withColor = hasColorColumn(db);
  // Build the projection dynamically. DISTINCT collapses n:m
  // (tag_id, route_id) rows back to a single row per tag -- the
  // color is identical per tag (the adapter denormalizes from
  // TAGS), so DISTINCT doesn't lose information.
  const projection = `tag_id, tag_label, priority, icon${withColor ? ', color' : ''}`;
  const rows = selectAll<Row>(
    db,
    `SELECT DISTINCT ${projection}
     FROM _route_tags
     ORDER BY priority ASC, tag_id ASC;`,
  );
  return rows.map((r) => ({
    id: r.tag_id,
    name: r.tag_label ?? r.tag_id,
    priority: r.priority ?? 0,
    icon: r.icon && r.icon.length > 0 ? r.icon : undefined,
    color: r.color && r.color.length > 0 ? r.color : undefined,
  }));
}
