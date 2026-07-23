/*
 * getActiveTrips — every trip currently in transit feed-wide, no
 * per-stop join. Drives the worker's reconciliation pipeline: each
 * live poll calls this, hands the result + the live observations to
 * `reconcileWithLive`, and broadcasts the resulting Vehicle[].
 *
 * Returned Vehicles are all `kind: 'scheduled'`. Schedule fields are
 * origin-relative (`scheduledDeparture = tripStartMin`,
 * `scheduledArrival = tripEndMin`). Consumers that need per-stop
 * ETA recompute it locally.
 *
 * For frequency-based trips (rows in `frequencies.txt`), each
 * generated departure is emitted as its own `kind: 'scheduled'`
 * Vehicle with `schedule.tripStartMin` set to the effective
 * departure time and `id: trip:${tripId}@${effectiveStartMin}`.
 * The reconciler matches live observations via the composite
 * `(tripId, tripStartMin)` key in `enrichObservations.ts`.
 */

import type { Database } from '@sqlite.org/sqlite-wasm';
import type { Route, Vehicle } from '$lib/domain/types';
import { MISSING_ROUTE_COLOR, vehicleTypeFromGtfs } from '$lib/domain/types';
import { dateKeyInTz, minSinceMidnightInTz, timeToMinutes } from '$lib/domain/pipeline/timeUtils';
import { activeServicesOn } from '../activeServices';
import { selectAll } from '../sqlHelpers';
import {
  expandFrequencyToDepartures,
  getFrequenciesForServices,
} from './frequencyExpansion';
import { getRoutesWithSchedule } from './routesWithSchedule';

export function getActiveTrips(
  db: Database,
  tz: string,
  nowMs: number,
  lookbackMin: number,
  lookaheadMin: number,
  hasFrequencies: boolean,
): Vehicle[] {
  const localDate = dateKeyInTz(nowMs, tz);
  const nowMin = minSinceMidnightInTz(nowMs, tz);

  const services = activeServicesOn(db, localDate);
  if (services.length === 0) return [];

  const placeholders = services.map(() => '?').join(',');
  type TripRow = {
    trip_id: string;
    trip_headsign: string | null;
    direction_id: number | null;
    trip_start_time: string;
    trip_end_time: string;
    route_id: string;
    route_short_name: string;
    route_color: string | null;
    route_text_color: string | null;
    route_type: number | null;
  };
  // Trip-level scan (no stop_times join in the select list): one
  // row per active trip with origin/end-stop times via the same
  // correlated subqueries getRouteMapView uses. Cheap thanks to
  // stop_times_trip_seq_idx. For frequency-based trips the row
  // is the anchor; we read the anchor's start/end times here and
  // generate the per-departure `schedule.tripStartMin` values in
  // the loop below.
  const rows = selectAll<TripRow>(
    db,
    `SELECT t.trip_id, t.trip_headsign, t.direction_id,
            (SELECT departure_time FROM stop_times WHERE trip_id = t.trip_id
             ORDER BY stop_sequence ASC LIMIT 1) AS trip_start_time,
            (SELECT arrival_time FROM stop_times WHERE trip_id = t.trip_id
             ORDER BY stop_sequence DESC LIMIT 1) AS trip_end_time,
            r.route_id, r.route_short_name, r.route_color, r.route_text_color, r.route_type
     FROM trips t
     JOIN routes r ON r.route_id = t.route_id
     WHERE t.service_id IN (${placeholders});`,
    services,
  );

  const lower = nowMin - lookbackMin;
  const upper = nowMin + lookaheadMin;
  const withSchedule = getRoutesWithSchedule(db);
  // Anchor trip data keyed by trip_id for the frequency-expansion
  // pass below. Avoids a second trip-level scan.
  const anchorByTripId = new Map<string, TripRow>();
  for (const r of rows) anchorByTripId.set(r.trip_id, r);
  const out: Vehicle[] = [];
  const pushAnchor = (r: TripRow, effectiveStartMin: number, idSuffix: string): void => {
    const dir: 0 | 1 | -1 =
      r.direction_id === 0 || r.direction_id === 1 ? r.direction_id : -1;
    const route: Route = {
      id: String(r.route_id),
      shortName: r.route_short_name,
      color: r.route_color ? `#${r.route_color}` : MISSING_ROUTE_COLOR,
      textColor: r.route_text_color ? `#${r.route_text_color}` : undefined,
      type: vehicleTypeFromGtfs(r.route_type),
      hasSchedule: withSchedule.has(String(r.route_id)),
    };
    out.push({
      kind: 'scheduled',
      id: `trip:${r.trip_id}${idSuffix}`,
      route,
      type: route.type ?? 'unknown',
      tripId: r.trip_id,
      directionId: dir,
      headsign: r.trip_headsign ?? undefined,
      confidence: 'low',
      schedule: {
        tripId: r.trip_id,
        scheduledDeparture: effectiveStartMin,
        scheduledArrival: effectiveStartMin,
        tripStartMin: effectiveStartMin,
        headsign: r.trip_headsign ?? undefined,
        directionId: dir,
      },
    });
  };
  for (const r of rows) {
    const tripStartMin = timeToMinutes(r.trip_start_time);
    const tripEndMin = timeToMinutes(r.trip_end_time);
    if (tripStartMin < lower || tripStartMin > upper) continue;
    if (tripEndMin < nowMin) continue;
    pushAnchor(r, tripStartMin, '');
  }
  // Frequency expansion: for each frequencies row whose anchor is
  // in the active services, emit one Vehicle per generated
  // departure in the window. Skipped when the loaded SQLite blob
  // has no `frequencies` table (cached blobs that pre-date
  // gtfs-publisher#252).
  if (hasFrequencies) {
    const freqs = getFrequenciesForServices(db, services);
    for (const f of freqs) {
      const anchor = anchorByTripId.get(f.trip_id);
      if (!anchor) continue;
      const anchorStartMin = timeToMinutes(anchor.trip_start_time);
      const anchorEndMin = timeToMinutes(anchor.trip_end_time);
      if (!Number.isFinite(anchorStartMin) || !Number.isFinite(anchorEndMin)) continue;
      const headwayMin = f.headway_secs / 60;
      const deps = expandFrequencyToDepartures(f, lower, upper);
      for (const dep of deps) {
        // Per-stop end time is anchor's last-stop time + k*headway.
        // Skip departures whose effective end is already past `now`
        // (the trip is fully done; nothing to display).
        const effectiveEndMin = anchorEndMin + (dep.effectiveStartMin - anchorStartMin);
        if (effectiveEndMin < nowMin) continue;
        pushAnchor(anchor, dep.effectiveStartMin, `@${dep.effectiveStartMin}`);
      }
    }
  }
  return out;
}
