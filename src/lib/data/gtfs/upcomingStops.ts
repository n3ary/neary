import { getGtfsRepo } from './repo';
import type { ScheduleTripStop } from './types';

/** Returns all stops after `currentStopId` for the given trip, in order.
 *  Slicing is done here so no filtering logic leaks into UI components. */
export async function getUpcomingStops(
  tripId: string,
  currentStopId: string,
): Promise<ScheduleTripStop[]> {
  const repo = getGtfsRepo();
  const all = await repo.getStopsAlongTrip(tripId);
  const idx = all.findIndex((s) => s.stopId === currentStopId);
  return idx >= 0 ? all.slice(idx + 1) : all;
}

/** Batched lookup: one worker call per unique trip across all vehicles
 *  on the station board. Returns a map keyed by tripId so the caller
 *  can derive per-vehicle remaining stops with the same `currentStopId`.
 *  Avoids N+1 round-trips when 10+ vehicles share a board. */
export async function getUpcomingStopsByTrip(
  tripIds: readonly string[],
  currentStopId: string,
): Promise<Map<string, ScheduleTripStop[]>> {
  const repo = getGtfsRepo();
  const out = new Map<string, ScheduleTripStop[]>();
  await Promise.all(
    Array.from(new Set(tripIds)).map(async (tripId) => {
      const all = await repo.getStopsAlongTrip(tripId);
      const idx = all.findIndex((s) => s.stopId === currentStopId);
      out.set(tripId, idx >= 0 ? all.slice(idx + 1) : all);
    }),
  );
  return out;
}
