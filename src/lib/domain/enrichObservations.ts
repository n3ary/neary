// Resolve live observations against the static-trip index. Pure: no IO. Caller owns the active-trips snapshot.

import type { LiveVehicleObservation } from '$lib/data/live/gtfsRtClient';
import { minutesToTime, timeToMinutes } from './pipeline/timeUtils';
import type { Vehicle } from './types';

interface ActiveTripEntry {
  directionId: 0 | 1;
  tripStartMin: number;
}

/** Composite-key index: `${tripId}|${effectiveStartMin}` → entry. The
 *  composite key is required for frequency-based trips — the app's
 *  frequency-expansion helper emits one Vehicle per generated
 *  departure (see #347), all sharing the anchor's tripId but with
 *  distinct `tripStartMin` (the effective time of the k-th departure).
 *  A bare tripId key would collapse the map on the last-written entry
 *  and the reconciler would match every observation against the wrong
 *  generated departure. The key is the same encoding the per-stop
 *  promotion path uses in `stationBoard.ts:mergeReconciledIntoStationBoard`. */
type CompositeIndex = ReadonlyMap<string, ActiveTripEntry>;

/** tripId → first entry. Fallback for observations with no
 *  startTime. For non-frequency trips there's exactly one entry per
 *  tripId; for frequency-based trips, the iteration finds the k=0
 *  entry (the anchor's first departure), which is the legacy
 *  "tripId-only match" behaviour for ambiguous cases. */
type TripIdIndex = ReadonlyMap<string, ActiveTripEntry>;

/** Build both indices from the worker's active-trips snapshot. */
export function indexActiveTrips(active: readonly Vehicle[]): {
  byComposite: CompositeIndex;
  byTripId: TripIdIndex;
} {
  const byComposite: Map<string, ActiveTripEntry> = new Map();
  const byTripId: Map<string, ActiveTripEntry> = new Map();
  for (const v of active) {
    if (!v.tripId) continue;
    const dir = v.schedule?.directionId;
    const start = v.schedule?.tripStartMin;
    if ((dir !== 0 && dir !== 1) || typeof start !== 'number') continue;
    const entry: ActiveTripEntry = { directionId: dir, tripStartMin: start };
    byComposite.set(`${v.tripId}|${start}`, entry);
    if (!byTripId.has(v.tripId)) byTripId.set(v.tripId, entry);
  }
  return { byComposite, byTripId };
}

/** Back-compat shim — the old API returned a single Map keyed by
 *  tripId. Kept for tests and any external callers; new code should
 *  use `indexActiveTrips` for the composite path. */
export function indexActiveTripsByTripId(active: readonly Vehicle[]): TripIdIndex {
  return indexActiveTrips(active).byTripId;
}

export function enrichObservations(
  observations: readonly LiveVehicleObservation[],
  active: readonly Vehicle[],
): LiveVehicleObservation[] {
  const { byComposite, byTripId } = indexActiveTrips(active);
  return observations.map((obs) => enrichOne(obs, byComposite, byTripId));
}

function enrichOne(
  obs: LiveVehicleObservation,
  byComposite: CompositeIndex,
  byTripId: TripIdIndex,
): LiveVehicleObservation {
  // Primary: composite key. For non-frequency trips the obs's
  // startTime is the anchor's origin departure, identical to the
  // active set's `tripStartMin`. For `UNSCHEDULED` observations
  // (frequency-based trips per
  // docs/specs/gtfs-rt-contract.md:89-90), the startTime is one
  // specific generated departure's effective time.
  const startMin = obs.startTime ? timeToMinutes(obs.startTime) : Number.NaN;
  let sched: ActiveTripEntry | undefined;
  if (obs.tripId && Number.isFinite(startMin)) {
    sched = byComposite.get(`${obs.tripId}|${startMin}`);
  }
  // Fallback: tripId-only. Preserves the legacy lenient behaviour
  // for non-conforming producers that don't populate startTime on
  // non-frequency observations. For frequency-based trips this
  // resolves to the k=0 entry, which is the anchor's first
  // departure — not strictly correct (an observation without
  // startTime is genuinely ambiguous), but the best we can do and
  // matches pre-#347 behaviour.
  if (!sched && obs.tripId) {
    sched = byTripId.get(obs.tripId);
  }
  if (sched) {
    return {
      ...obs,
      directionId: sched.directionId,
      startTime: minutesToTime(sched.tripStartMin),
    };
  }
  return obs;
}
