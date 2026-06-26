/*
 * reconcile — merge live GPS observations into a scheduled vehicle list.
 *
 * Spec: vehicles-and-views.md §6.1 (canonical trip_id match) is the only
 * path implemented here. Late-vehicle handling (§7.3), suspect duplicates
 * (§7.4), and the terminus heuristic (§7.5) land in subsequent commits.
 *
 * Inputs:
 *   scheduled  - the per-stop board the GTFS worker produced, all
 *                kind: 'scheduled', already including dropOffOnly /
 *                schedule / eta from the schedule scanner.
 *   live       - LiveVehicleObservation[] from the GTFS-RT poller. Not
 *                filtered to this stop; we use tripId to join.
 *
 * Output: a Vehicle[] of the same length as `scheduled`. Each input is
 * either passed through unchanged (no live match) or upgraded to
 * kind: 'reconciled' (live match) carrying the GPS position. The
 * scheduled eta is preserved \u2014 a real GPS-derived ETA arrives in a
 * later commit when the prediction engine ports over.
 *
 * Pure. No DOM, no stores, no I/O.
 */

import type { LiveVehicleObservation } from '$lib/data/live/gtfsRtClient';
import type { Vehicle } from './types';

export interface ReconcileStats {
  /** Number of scheduled rows that found a live trip_id match. */
  matched: number;
  /** Number of scheduled rows with no live match. */
  unmatched: number;
}

export function reconcileWithLive(
  scheduled: Vehicle[],
  live: LiveVehicleObservation[],
): { vehicles: Vehicle[]; stats: ReconcileStats } {
  // Index live observations by trip_id for O(1) lookup. Skip
  // observations without a trip_id \u2014 those can't be tied to any stop.
  const byTripId = new Map<string, LiveVehicleObservation>();
  for (const obs of live) {
    if (obs.tripId) byTripId.set(obs.tripId, obs);
  }

  let matched = 0;
  let unmatched = 0;

  const vehicles = scheduled.map<Vehicle>((v) => {
    if (v.kind !== 'scheduled') {
      // Already promoted by an earlier stage (or by another reconciler).
      // Leave it alone \u2014 idempotent.
      return v;
    }
    const tripId = v.schedule.tripId;
    const obs = byTripId.get(tripId);
    if (!obs) {
      unmatched += 1;
      return v;
    }
    matched += 1;
    return {
      kind: 'reconciled',
      id: v.id, // stable: trip:<tripId>, survives the upgrade
      route: v.route,
      type: v.type,
      schedule: v.schedule,
      headsign: v.headsign,
      eta: v.eta,
      dropOffOnly: v.dropOffOnly,
      confidence: 'medium',
      position: {
        lat: obs.lat,
        lon: obs.lon,
        source: 'gps',
        asOf: obs.asOfMs > 0 ? obs.asOfMs : Date.now(),
      },
      liveSources: ['gtfs-rt'],
    };
  });

  return { vehicles, stats: { matched, unmatched } };
}
