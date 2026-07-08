import { getGtfsRepo } from './repo';
import type { ScheduleTripStop } from './types';

/** Returns all stops after `currentStopId` for the given trip, in order.
 *  Slicing is done here so no filtering logic leaks into UI components.
 *  Used by both the per-vehicle expanded-stops list and the headsign
 *  marker badge surface - both slice from this station forward, so
 *  one helper covers both callers. */
export async function getUpcomingStops(
  tripId: string,
  currentStopId: string,
): Promise<ScheduleTripStop[]> {
  const repo = getGtfsRepo();
  const all = await repo.getStopsAlongTrip(tripId);
  const idx = all.findIndex((s) => s.stopId === currentStopId);
  return idx >= 0 ? all.slice(idx + 1) : all;
}
