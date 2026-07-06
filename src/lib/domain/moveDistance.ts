/*
 * moveDistance - pure helpers for "has the user moved enough that we
 * should re-query?" Used by the Stations view to gate its boards-query
 * effect so GPS jitter (~25 m on the low-accuracy setting) doesn't fire
 * spurious SQLite round-trips while the rider is stationary, and so a
 * movement past the configured threshold both re-fetches AND resets
 * view-only user choices (expanded station, route filter).
 *
 * Lives in the domain (no DOM, no stores) so a unit test can pin the
 * threshold semantics in one place. Threshold lives in NearyConfig so
 * the spec / advanced settings can override it later.
 */

import { haversineMeters, type LatLon } from '@n3ary/gtfs-spec/shape';

/** True iff `current` is `thresholdM` or more meters away from
 *  `previous`. Treats a missing `previous` as "moved" so first-load
 *  callers always refetch. */
export function hasMovedSignificantly(
  previous: LatLon | null | undefined,
  current: LatLon,
  thresholdM: number,
): boolean {
  if (!previous) return true;
  const dist = haversineMeters(
    previous.lat, previous.lon, current.lat, current.lon,
  );
  return dist >= thresholdM;
}