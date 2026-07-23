/*
 * One round-trip payload backing the route-map view: every trip
 * currently active on (routeId, directionId) plus a representative
 * shape polyline + stops for the direction. The shape + stops
 * always render — even when no trip is active right now — so the
 * user sees route geometry at any time.
 *
 * Helpers (load*, find*) are local because they have no other
 * consumer; `loadShape` does share `shapeCache` with
 * `getShapesForTrips`, which is fine — both routes through the
 * same singleton.
 */

import type { Database } from '@sqlite.org/sqlite-wasm';
import type { RouteMapTrip, RouteMapView, ScheduleTripStop } from '$lib/data/gtfs/types';
import { timeToMinutes } from '$lib/domain/pipeline/timeUtils';
import { MISSING_ROUTE_COLOR, vehicleTypeFromGtfs } from '$lib/domain/types';
import { activeServicesOn } from '../activeServices';
import { shapeCache } from '../shapeCache';
import { selectAll } from '../sqlHelpers';
import {
  expandFrequencyToDepartures,
  getFrequenciesForServices,
} from './frequencyExpansion';
import { getRoutesWithSchedule } from './routesWithSchedule';

export function getRouteMapView(
  db: Database,
  routeId: string,
  directionId: 0 | 1,
  localDate: string,
  localMin: number,
  lookbackMin: number,
  lookaheadMin: number,
  hasFrequencies: boolean,
): RouteMapView | null {
  type RouteRow = {
    route_id: string;
    route_short_name: string;
    route_color: string | null;
    route_text_color: string | null;
    route_type: number | null;
    tag_ids: string | null;
    network_ids: string | null;
  };
  // Probe both producer extensions (tag + network) so the route
  // badge in the map-view header can render the same chips the
  // schedule + favorites surfaces do. Older cached blobs without the
  // tables fall back to NULL for both columns.
  //
  // Aggregation runs as correlated subqueries (not LEFT JOIN +
  // GROUP_CONCAT) for two reasons:
  //   1. `GROUP_CONCAT(DISTINCT x, sep)` is invalid SQLite — the
  //      parser treats `(DISTINCT x, sep)` as DISTINCT taking two
  //      arguments and throws "DISTINCT aggregates must have
  //      exactly one argument".
  //   2. LEFT JOINing two 1:many tables together produces a
  //      cartesian product (a route with N tags and M networks →
  //      N*M rows), which would repeat every tag M times and every
  //      network N times inside the GROUP_CONCAT result.
  const tables = selectAll<{ name: string }>(
    db,
    `SELECT name FROM sqlite_master WHERE type IN ('table')
     AND name IN ('_route_tags', 'route_networks', 'frequencies');`,
  );
  const hasRouteTags = tables.some((t) => t.name === '_route_tags');
  const hasRouteNetworks = tables.some((t) => t.name === 'route_networks');
  const tagSelect = hasRouteTags
    ? "(SELECT GROUP_CONCAT(rt.tag_id, ',' ORDER BY rt.priority ASC) FROM _route_tags rt WHERE rt.route_id = r.route_id) AS tag_ids"
    : 'NULL AS tag_ids';
  const netSelect = hasRouteNetworks
    ? "(SELECT GROUP_CONCAT(rn.network_id, ',') FROM route_networks rn WHERE rn.route_id = r.route_id) AS network_ids"
    : 'NULL AS network_ids';
  const routeRows = selectAll<RouteRow>(
    db,
    `SELECT r.route_id, r.route_short_name, r.route_color, r.route_text_color, r.route_type,
            ${tagSelect}, ${netSelect}
     FROM routes r
     WHERE r.route_id = ?;`,
    [routeId],
  );
  if (routeRows.length === 0) return null;
  const r = routeRows[0];
  const withSchedule = getRoutesWithSchedule(db);
  const route = {
    id: String(r.route_id),
    shortName: r.route_short_name,
    color: r.route_color ? `#${r.route_color}` : MISSING_ROUTE_COLOR,
    textColor: r.route_text_color ? `#${r.route_text_color}` : undefined,
    type: vehicleTypeFromGtfs(r.route_type),
    hasSchedule: withSchedule.has(String(r.route_id)),
    tags: r.tag_ids
      ? r.tag_ids.split(',').filter(Boolean)
      : undefined,
    networks: r.network_ids
      ? r.network_ids.split(',').filter(Boolean)
      : undefined,
  };

  // 1) Active trips on (route, direction). Origin departure within
  // [localMin - lookbackMin, localMin + lookaheadMin], AND not yet
  // past the end stop. Empty when no calendar is active today
  // (services=[]) OR when every trip is either past or out of
  // window — in either case we still want to render the route
  // structure (see step 3 below), so don't early-return here.
  const services = activeServicesOn(db, localDate);
  type TripRow = {
    trip_id: string;
    trip_headsign: string | null;
    shape_id: string | null;
    trip_start_time: string;
    trip_end_time: string;
  };
  let activeTripRows: Array<TripRow & { tripStartMin: number; tripEndMin: number }> = [];
  if (services.length > 0) {
    const placeholders = services.map(() => '?').join(',');
    const tripRows = selectAll<TripRow>(
      db,
      `SELECT t.trip_id, t.trip_headsign, t.shape_id,
              (SELECT departure_time FROM stop_times WHERE trip_id = t.trip_id
               ORDER BY stop_sequence ASC LIMIT 1) AS trip_start_time,
              (SELECT arrival_time FROM stop_times WHERE trip_id = t.trip_id
               ORDER BY stop_sequence DESC LIMIT 1) AS trip_end_time
       FROM trips t
       WHERE t.route_id = ?
         AND t.direction_id = ?
         AND t.service_id IN (${placeholders});`,
      [routeId, directionId, ...services],
    );
    const lowerMin = localMin - lookbackMin;
    const upperMin = localMin + lookaheadMin;
    activeTripRows = tripRows
      .map((row) => ({
        ...row,
        tripStartMin: timeToMinutes(row.trip_start_time),
        tripEndMin: timeToMinutes(row.trip_end_time),
      }))
      .filter((row) => row.tripStartMin >= lowerMin && row.tripStartMin <= upperMin && row.tripEndMin >= localMin)
      .sort((a, b) => a.tripStartMin - b.tripStartMin);
    // Frequency expansion: for each frequencies row on this
    // (route, direction) in the active services, emit one
    // generated departure in [lowerMin, upperMin]. Use the
    // anchor's shape_id (shape doesn't change per generated
    // departure).
    if (hasFrequencies) {
      const freqs = getFrequenciesForServices(db, services);
      for (const f of freqs) {
        const anchor = tripRows.find((r) => r.trip_id === f.trip_id);
        if (!anchor) continue;
        const anchorStartMin = timeToMinutes(anchor.trip_start_time);
        const anchorEndMin = timeToMinutes(anchor.trip_end_time);
        if (!Number.isFinite(anchorStartMin) || !Number.isFinite(anchorEndMin)) continue;
        const deps = expandFrequencyToDepartures(f, lowerMin, upperMin);
        for (const dep of deps) {
          const effectiveEndMin = anchorEndMin + (dep.effectiveStartMin - anchorStartMin);
          if (effectiveEndMin < localMin) continue;
          activeTripRows.push({
            trip_id: anchor.trip_id,
            trip_headsign: anchor.trip_headsign,
            shape_id: anchor.shape_id,
            trip_start_time: anchor.trip_start_time,
            trip_end_time: anchor.trip_end_time,
            tripStartMin: dep.effectiveStartMin,
            tripEndMin: effectiveEndMin,
          });
        }
      }
      // Re-sort after expansion so the map view's "earliest
      // upcoming" pick is correct.
      activeTripRows.sort((a, b) => a.tripStartMin - b.tripStartMin);
    }
  }

  // 2) Stops for every active trip, in one query. Skipped when
  // there are no active trips — the representative-stop path
  // below handles structure-only renders.
  const stopsByTrip = activeTripRows.length === 0
    ? new Map<string, ScheduleTripStop[]>()
    : loadStopsForTrips(db, Array.from(new Set(activeTripRows.map((t) => t.trip_id))));

  const trips: RouteMapTrip[] = activeTripRows.map((t) => ({
    tripId: t.trip_id,
    headsign: t.trip_headsign,
    tripStartMin: t.tripStartMin,
    tripEndMin: t.tripEndMin,
    stops: stopsByTrip.get(t.trip_id) ?? [],
  }));

  // 3) Representative shape + stops. The route+direction has a
  // STABLE structure independent of whether any trip is running
  // right now — a daytime route at midnight, or a route with no
  // calendar exception today, should still show its line and
  // station markers so the user can see "yes this route exists,
  // it just has no active vehicles". Prefer an active trip when
  // we have one; otherwise pull a representative trip via the
  // same `LIMIT 1` shape getRouteDirectionEndpoints uses.
  const repTripId = activeTripRows[0]?.trip_id ?? findRepresentativeTripId(db, routeId, directionId);
  if (!repTripId) {
    // Truly no trip ever recorded for this direction (one-way loop,
    // typo in URL, etc.). UI already disables the swap button via
    // useOtherDirectionExists, but be defensive.
    return { route, shape: [], stops: [], trips: [] };
  }
  const repShapeId = activeTripRows[0]?.shape_id ?? findShapeIdForTrip(db, repTripId);
  const shape = repShapeId ? loadShape(db, repShapeId) : [];
  const repStops = stopsByTrip.get(repTripId) ?? loadStopsForTrip(db, repTripId);

  return { route, shape, stops: repStops, trips };
}

// ---------------------------------------------------------------------------
// Local helpers. Kept here (not promoted to the worker-level helpers)
// because they have no other consumer.
// ---------------------------------------------------------------------------

function loadStopsForTrips(
  db: Database,
  tripIds: readonly string[],
): Map<string, ScheduleTripStop[]> {
  const out = new Map<string, ScheduleTripStop[]>();
  if (tripIds.length === 0) return out;
  const tripPh = tripIds.map(() => '?').join(',');
  type Row = {
    trip_id: string; stop_id: string; stop_name: string;
    stop_lat: number; stop_lon: number;
    arrival_time: string; stop_sequence: number;
    shape_dist_traveled: number | null;
  };
  const rows = selectAll<Row>(
    db,
    `SELECT st.trip_id, s.stop_id, s.stop_name, s.stop_lat, s.stop_lon,
            st.arrival_time, st.stop_sequence, st.shape_dist_traveled
     FROM stop_times st
     JOIN stops s ON s.stop_id = st.stop_id
     WHERE st.trip_id IN (${tripPh})
     ORDER BY st.trip_id, st.stop_sequence ASC;`,
    tripIds,
  );
  for (const sr of rows) {
    const list = out.get(sr.trip_id) ?? [];
    list.push({
      stopId: sr.stop_id,
      stopName: sr.stop_name,
      lat: sr.stop_lat,
      lon: sr.stop_lon,
      arrivalTime: sr.arrival_time,
      arrivalMin: timeToMinutes(sr.arrival_time),
      stopSequence: sr.stop_sequence,
      distAlongM: sr.shape_dist_traveled ?? undefined,
    });
    out.set(sr.trip_id, list);
  }
  return out;
}

function loadStopsForTrip(db: Database, tripId: string): ScheduleTripStop[] {
  return loadStopsForTrips(db, [tripId]).get(tripId) ?? [];
}

function loadShape(db: Database, shapeId: string): Array<{ lat: number; lon: number }> {
  const cached = shapeCache.get(shapeId);
  if (cached) return cached;
  type Row = { shape_pt_lat: number; shape_pt_lon: number };
  const pts = selectAll<Row>(
    db,
    `SELECT shape_pt_lat, shape_pt_lon FROM shapes
     WHERE shape_id = ? ORDER BY shape_pt_sequence;`,
    [shapeId],
  );
  const shape = pts.map((p) => ({ lat: p.shape_pt_lat, lon: p.shape_pt_lon }));
  shapeCache.set(shapeId, shape);
  return shape;
}

/** Any trip_id on (route, direction), regardless of service_id. Lets
 *  the map view render the route's stable structure (shape + stops)
 *  even when no trip is active right now. */
function findRepresentativeTripId(
  db: Database, routeId: string, directionId: 0 | 1,
): string | null {
  type Row = { trip_id: string };
  const rows = selectAll<Row>(
    db,
    `SELECT trip_id FROM trips
     WHERE route_id = ? AND direction_id = ? LIMIT 1;`,
    [routeId, directionId],
  );
  return rows[0]?.trip_id ?? null;
}

function findShapeIdForTrip(db: Database, tripId: string): string | null {
  type Row = { shape_id: string | null };
  const rows = selectAll<Row>(
    db, `SELECT shape_id FROM trips WHERE trip_id = ? LIMIT 1;`, [tripId],
  );
  return rows[0]?.shape_id ?? null;
}
