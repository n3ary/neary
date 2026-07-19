import { measurePolyline, projectOnPolyline } from '@n3ary/gtfs-spec/shape';
import { deadReckonGpsAlongShape } from '$lib/domain/predictPosition';
import { predictArrivalAlongShape } from '$lib/domain/predictArrivalAlongShape';
import { DEFAULT_FEED_SPEED_CONFIG, type FeedSpeedConfig } from '$lib/domain/speedCascade';
import { clockToBucket, DEFAULT_TOD_PROFILE, type TodProfile } from '$lib/domain/timeOfDay';
import { minSinceMidnightInTz } from '$lib/domain/pipeline/timeUtils';
import { getGtfsRepo } from './repo';
import type { ScheduleTripStop } from './types';

/** Returns all stops after `currentStopId` for the given trip, in order.
 *  Slicing is done here so no filtering logic leaks into UI components.
 *  Used by both the per-vehicle expanded-stops list and the headsign
 *  marker badge surface - both slice from this station forward, so
 *  one helper covers both callers.
 *
 *  Uses `shape_dist_traveled` (when available) to determine physical
 *  travel direction. `stop_sequence` is the fallback, but it does not
 *  guarantee monotonic physical order for loop routes or out-of-order
 *  GTFS feeds — a stop listed before the current station in sequence may
 *  still be physically after it if the route doubles back. */
export async function getUpcomingStops(
  tripId: string,
  currentStopId: string,
): Promise<ScheduleTripStop[]> {
  const repo = getGtfsRepo();
  const all = await repo.getStopsAlongTrip(tripId);
  return sliceAfterCurrent(all, currentStopId);
}

/** Live context for estimating per-stop ETAs on the orphan path. */
export interface OrphanStopEstimateLive {
  obs: { lat: number; lon: number; speedMs: number | null; asOfMs: number };
  nowMs: number;
  timezone?: string;
  feedConfig?: FeedSpeedConfig;
  todProfile?: TodProfile;
  dwellSecondsPerStop?: number;
}

/** Same as getUpcomingStops, but for orphan (`gps-only`) vehicles,
 *  which have no static trip: the route+direction's representative
 *  stop sequence stands in. When `live` is provided (and the shape is
 *  known), each stop's time is replaced by a dead-reckoned estimate —
 *  the same speed-cascade + dwell math as the station row's own ETA —
 *  and flagged `estimated` so the UI marks it "~". Without `live`,
 *  times belong to the representative trip, not the orphan — callers
 *  should hide them. */
export async function getUpcomingStopsForRouteDir(
  routeId: string,
  directionId: 0 | 1,
  currentStopId: string,
  live?: OrphanStopEstimateLive,
): Promise<ScheduleTripStop[]> {
  const repo = getGtfsRepo();
  const [all, shape] = await Promise.all([
    repo.getStopsAlongRouteDir(routeId, directionId),
    live ? repo.getShapeForRouteDir(routeId, directionId) : Promise.resolve(null),
  ]);
  const upcoming = sliceAfterCurrent(all, currentStopId);
  if (!live || !shape || shape.length < 2 || upcoming.length === 0) return upcoming;

  // Dead-reckon the fix once to "now", then price every stop from
  // that walked position. Dwell distances come from projecting the
  // full stop sequence — the walk and the ETAs share the same list.
  const measured = measurePolyline(shape);
  const dwellStopDistAlongM = all
    .map((s) => projectOnPolyline({ lat: s.lat, lon: s.lon }, shape).distAlongM)
    .sort((a, b) => a - b);
  const dr = deadReckonGpsAlongShape(
    live.obs,
    measured,
    live.nowMs,
    {
      timezone: live.timezone,
      feedConfig: live.feedConfig ?? DEFAULT_FEED_SPEED_CONFIG,
      todProfile: live.todProfile,
    },
    {
      stopDistAlongM: dwellStopDistAlongM,
      dwellSecondsPerStop: live.dwellSecondsPerStop,
    },
  );
  if (!dr) return upcoming; // fix older than 15 min — no anchor to estimate from
  const todBucket = clockToBucket(
    minSinceMidnightInTz(live.nowMs, live.timezone ?? 'UTC'),
    live.todProfile ?? DEFAULT_TOD_PROFILE,
  );
  const nowLocalMin = minSinceMidnightInTz(live.nowMs, live.timezone ?? 'UTC');
  return upcoming.map((s) => {
    const arrival = predictArrivalAlongShape({
      vehiclePos: dr.position,
      stopPos: { lat: s.lat, lon: s.lon },
      polyline: shape,
      vehicleSpeedMs: live.obs.speedMs,
      todBucket,
      feedConfig: live.feedConfig ?? DEFAULT_FEED_SPEED_CONFIG,
      dwellStopDistAlongM,
      dwellSecondsPerStop: live.dwellSecondsPerStop,
    });
    if (arrival?.minutes == null || arrival.minutes <= 0) return s;
    return { ...s, arrivalMin: nowLocalMin + Math.round(arrival.minutes), estimated: true };
  });
}

/** Stops physically after `currentStopId` within one stop sequence.
 *  `shape_dist_traveled` is the canonical physical order — it handles
 *  loop routes and out-of-sequence stop_times entries correctly;
 *  `stop_sequence` is the fallback, but it does not guarantee
 *  monotonic physical order (a stop listed before the current station
 *  in sequence may still be physically after it if the route doubles
 *  back). */
function sliceAfterCurrent(
  all: ScheduleTripStop[],
  currentStopId: string,
): ScheduleTripStop[] {
  const current = all.find((s) => s.stopId === currentStopId);
  if (!current) return []; // current stop not in this trip — caller error, fail safe

  if (current.distAlongM != null) {
    return all.filter((s) => s.distAlongM != null && s.distAlongM > current.distAlongM!);
  }

  const idx = all.findIndex((s) => s.stopId === currentStopId);
  return idx >= 0 ? all.slice(idx + 1) : [];
}
