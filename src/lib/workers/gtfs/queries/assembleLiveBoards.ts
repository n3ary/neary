/*
 * Worker-side assembly of per-stop live boards.
 *
 * Replaces the main-thread `shapes` + `stopDistancesByTrip` fetch that
 * used to feed `assembleLiveVehicles` on every reactive tick. Now the
 * worker has the SQLite DB right here, so:
 *
 *   1. Collect trip_ids from the per-stop scheduled vehicles + every
 *      live (`tracked`/`gps-only`) reconciled vehicle the page might
 *      need to render (any reconciled vehicle whose route appears on
 *      one of the boards).
 *   2. Resolve shapes + stop distances for that trip set (one SQL
 *      round-trip each; shape polylines are cached worker-side by
 *      shape_id via `shapeCache`).
 *   3. Call the pure `assembleLiveVehicles` per board (merge + GPS-ETA).
 *
 * Result: shape / stop-distance payloads never cross the IPC boundary
 * any more. Main thread receives Vehicle[] per stop, already with
 * `kind`, ETA, and position GPS-adjusted; the page just buckets/filters
 * via `bucketLiveBoardMemo`.
 */

import type { Database } from '@sqlite.org/sqlite-wasm';
import { assembleLiveVehicles } from '$lib/domain/stationBoard';
import type { Vehicle } from '$lib/domain/types';
import type { ReconciledSnapshot } from '$lib/data/gtfs/types';

import { getShapesForTrips } from './shapes';
import { getStopDistancesForTrips } from './routeStops';

export type AssembleLiveBoardsInput = {
  stopId: number;
  stop: { lat?: number; lon?: number };
  vehicles: Vehicle[];
};

export type AssembleLiveBoardsResult = {
  stopId: number;
  vehicles: Vehicle[];
};

export function assembleLiveBoards(
  db: Database,
  timezone: string,
  snapshot: ReconciledSnapshot | null,
  boards: readonly AssembleLiveBoardsInput[],
  nowMs: number,
  dwellSec?: number,
): AssembleLiveBoardsResult[] {
  const reconciled = snapshot?.vehicles ?? [];

  // Union of trip_ids we need shapes / distances for: every per-stop
  // scheduled vehicle's trip_id, plus every live reconciled vehicle
  // whose route appears on any of the boards (those become gps-only
  // orphans during merge).
  const tripIds = new Set<string>();
  const visibleRouteIds = new Set<string>();
  for (const b of boards) {
    for (const v of b.vehicles) {
      visibleRouteIds.add(v.route.id);
      if (v.tripId) tripIds.add(v.tripId);
    }
  }
  for (const v of reconciled) {
    if (v.kind !== 'tracked' && v.kind !== 'gps-only') continue;
    if (!v.tripId) continue;
    if (!visibleRouteIds.has(v.route.id)) continue;
    tripIds.add(v.tripId);
  }

  const tripIdList = Array.from(tripIds);
  const shapes = getShapesForTrips(db, tripIdList);
  const stopDistancesByTrip = getStopDistancesForTrips(db, tripIdList);

  return boards.map(({ stopId, stop, vehicles }) => ({
    stopId,
    vehicles: assembleLiveVehicles({
      perStopVehicles: vehicles,
      stop,
      reconciledVehicles: reconciled,
      shapes,
      stopDistancesByTrip,
      nowMs,
      timezone,
      dwellSec,
    }),
  }));
}
