/*
 * Enrich live observations with authoritative scheduled-trip data.
 *
 * Runs after the RT parse and before the reconciler. For each observation:
 *
 *   1. If `obs.tripId` matches an active scheduled trip, copy
 *      `directionId` and `startTime` from the static feed. This is the
 *      hot path — when the RT feed publishes the same trip_id space
 *      as the static feed, the lookup fires for the vast majority of
 *      observations.
 *   2. Otherwise (orphan, deadhead, build skew, fix-up run) try the
 *      TEMP cluj trip_id recovery below.
 *   3. If neither path fires, leave the canonical RT fields as-is.
 *      Downstream the observation becomes unmatched / gps-only.
 *
 * Pure function: no IO, no DB access. Caller owns the active-trips
 * snapshot (already fetched per tick by `livePipeline.tickLive` for
 * the reconciler).
 */

import type { LiveVehicleObservation } from '$lib/data/live/gtfsRtClient';
import { minutesToTime } from './pipeline/timeUtils';
import type { Vehicle } from './types';

type ActiveTripIndex = ReadonlyMap<string, { directionId: 0 | 1; tripStartMin: number }>;

/** Build a tripId → {direction, startMin} index from the active-trips
 *  list the worker already fetches per tick. Cheap; size scales with
 *  the active cohort (a few hundred entries on a typical urban feed). */
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

/** Enrich a list of observations using the static feed's active-trips
 *  index. Observations whose `tripId` isn't in the index flow through
 *  unchanged — the reconciler treats them as orphans. */
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

// TEMP: cluj-napoca trip_id recovery — REMOVE THIS ENTIRE BLOCK when
// the producer's `packages/gtfs-rt` adapter ships canonical
// `direction_id` + `start_time` for Cluj upstream. Tracked at
// https://github.com/n3ary/gtfs/issues/36 (producer-side
// fix) and https://github.com/ciotlosm/neary/issues/161 (consumer-side
// removal trigger). Until the adapter lands, this is the only thing
// keeping Cluj observations from collapsing to gps-only orphans.
//
// Branching is on the trip_id SHAPE (regex below), not on `feed.id` /
// agency / city — so it stays compatible with
// `docs/standards/feed-agnostic.md` ("branch on capability or shape,
// never on feed.id, agency name, city, or any feed-specific token").
//
// Cluj RT audit: direction_id is always 0 (broken) and start_time is
// always empty, but trip_id carries the real values in a stable shape:
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
