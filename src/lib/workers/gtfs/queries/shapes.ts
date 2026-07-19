/*
 * Trip-shape resolution + caching for the GPS-ETA path.
 *
 * Two-step query:
 *   1. Resolve trip_id → shape_id (one IN(...) over `trips`).
 *   2. Load polylines for any uncached shape_ids (one grouped SELECT
 *      over `shapes`).
 *
 * Polylines cached in [`shapeCache`](../shapeCache.ts), which
 * persists across calls and is invalidated on feed switch. Trips
 * with no `shape_id` or an empty polyline are omitted from the
 * result — the caller falls back to scheduled ETA / sibling-route
 * shape for those.
 */

import type { Database } from '@sqlite.org/sqlite-wasm';
import { shapeCache } from '../shapeCache';
import { selectAll } from '../sqlHelpers';

/** Shape polyline for a route+direction — same LIMIT 1 rep-trip
 *  selection as `getStopsAlongRouteDir` (routeStops.ts). Used to
 *  estimate per-stop ETAs for orphan (`gps-only`) vehicles, which
 *  have no static trip of their own. */
export function getShapeForRouteDir(
  db: Database,
  routeId: string,
  directionId: 0 | 1,
): Array<{ lat: number; lon: number }> | null {
  type Row = { trip_id: string };
  const rows = selectAll<Row>(
    db,
    `SELECT trip_id FROM trips
     WHERE route_id = ? AND direction_id = ? LIMIT 1;`,
    [routeId, directionId],
  );
  const repTripId = rows[0]?.trip_id;
  if (!repTripId) return null;
  return getShapesForTrips(db, [repTripId])[repTripId] ?? null;
}

export function getShapesForTrips(
  db: Database,
  tripIds: readonly string[],
): Record<string, Array<{ lat: number; lon: number }>> {
  if (tripIds.length === 0) return {};

  // 1. trip_id → shape_id (deduped).
  const uniqTrips = Array.from(new Set(tripIds));
  const tripPh = uniqTrips.map(() => '?').join(',');
  type TripShapeRow = { trip_id: string; shape_id: string | null };
  const tripRows = selectAll<TripShapeRow>(
    db,
    `SELECT trip_id, shape_id FROM trips WHERE trip_id IN (${tripPh});`,
    uniqTrips,
  );
  const tripIdToShapeId = new Map<string, string>();
  for (const r of tripRows) {
    if (r.shape_id) tripIdToShapeId.set(r.trip_id, r.shape_id);
  }

  // 2. Fetch polylines for any uncached shape_ids in one grouped query.
  //    Composite index (shape_id, shape_pt_sequence) keeps this cheap.
  const neededShapeIds = new Set<string>();
  for (const sid of tripIdToShapeId.values()) {
    if (!shapeCache.has(sid)) neededShapeIds.add(sid);
  }
  if (neededShapeIds.size > 0) {
    const shapePh = Array.from(neededShapeIds).map(() => '?').join(',');
    type ShapeRow = { shape_id: string; shape_pt_lat: number; shape_pt_lon: number };
    const shapeRows = selectAll<ShapeRow>(
      db,
      `SELECT shape_id, shape_pt_lat, shape_pt_lon
       FROM shapes
       WHERE shape_id IN (${shapePh})
       ORDER BY shape_id, shape_pt_sequence;`,
      Array.from(neededShapeIds),
    );
    const grouped = new Map<string, Array<{ lat: number; lon: number }>>();
    for (const r of shapeRows) {
      const list = grouped.get(r.shape_id) ?? [];
      list.push({ lat: r.shape_pt_lat, lon: r.shape_pt_lon });
      grouped.set(r.shape_id, list);
    }
    for (const sid of neededShapeIds) {
      // Cache even empty shapes (negative cache) so a missing
      // shape_id doesn't re-query every render.
      shapeCache.set(sid, grouped.get(sid) ?? []);
    }
  }

  // 3. tripId-keyed result. Trips with no shape_id or empty polyline
  //    are omitted — caller falls back.
  const out: Record<string, Array<{ lat: number; lon: number }>> = {};
  for (const tid of uniqTrips) {
    const sid = tripIdToShapeId.get(tid);
    if (!sid) continue;
    const poly = shapeCache.get(sid);
    if (!poly || poly.length < 2) continue;
    out[tid] = poly;
  }
  return out;
}
