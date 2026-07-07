// Resolve live observations against the static-trip index. Pure: no IO. Caller owns the active-trips snapshot.

import type { LiveVehicleObservation } from '$lib/data/live/gtfsRtClient';
import { minutesToTime } from './pipeline/timeUtils';
import type { Vehicle } from './types';

type ActiveTripIndex = ReadonlyMap<string, { directionId: 0 | 1; tripStartMin: number }>;

// tripId → {direction, startMin}, from the active-trips the worker fetches per tick.
export function indexActiveTripsByTripId(active: readonly Vehicle[]): ActiveTripIndex {
  const out = new Map<string, { directionId: 0 | 1; tripStartMin: number }>();
  for (const v of active) {
    if (!v.tripId) continue;
    const dir = v.schedule?.directionId;
    const start = v.schedule?.tripStartMin;
    if ((dir !== 0 && dir !== 1) || typeof start !== 'number') continue;
    out.set(v.tripId, { directionId: dir, tripStartMin: start });
  }
  return out;
}

export function enrichObservations(
  observations: readonly LiveVehicleObservation[],
  active: readonly Vehicle[],
): LiveVehicleObservation[] {
  const byTripId = indexActiveTripsByTripId(active);
  return observations.map((obs) => enrichOne(obs, byTripId));
}

function enrichOne(
  obs: LiveVehicleObservation,
  byTripId: ActiveTripIndex,
): LiveVehicleObservation {
  const sched = obs.tripId ? byTripId.get(obs.tripId) : undefined;
  if (sched) {
    return {
      ...obs,
      directionId: sched.directionId,
      startTime: minutesToTime(sched.tripStartMin),
    };
  }
  const cluj = recoverClujTripFields(obs);
  if (cluj) {
    return { ...obs, directionId: cluj.directionId, startTime: cluj.startTime };
  }
  return obs;
}

// TEMP Cluj-Napoca trip_id recovery — REMOVE the block below (and this header) when
// n3ary/gtfs#36 lands canonical `direction_id` + `start_time`, and n3ary/app#161
// removes the consumer-side fallback. Until then, this is the only path keeping
// Cluj observations from collapsing to gps-only orphans.
//
// Branching is on the trip_id SHAPE (regex below), not on `feed.id` / agency /
// city — stays compatible with feed-agnostic.md ("branch on capability or shape,
// never on feed.id, agency name, city, or any feed-specific token").
//
// Cluj RT audit: direction_id is always 0 (broken) and start_time is always empty,
// but trip_id carries the real values in a stable shape:
//   ^<route>_<dir>_<service>_<run>_<HHMM>
const CLUJ_TRIP_ID = /^([^_]+)_([01])_[^_]+_[^_]+_(\d{4})$/;
function recoverClujTripFields(
  obs: LiveVehicleObservation,
): { directionId: 0 | 1; startTime: string } | null {
  if (!obs.tripId || obs.startTime) return null;
  const m = CLUJ_TRIP_ID.exec(obs.tripId);
  if (!m) return null;
  const hh = Number(m[3].slice(0, 2));
  const mm = Number(m[3].slice(2, 4));
  return {
    directionId: Number(m[2]) as 0 | 1,
    startTime: minutesToTime(hh * 60 + mm),
  };
}
