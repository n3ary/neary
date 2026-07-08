// Pure ranking helpers for the /favorites page. Kept in
// $lib/domain (not $lib/ui) because they're about ordering data
// the rest of the domain layer doesn't otherwise touch.

import { haversineMeters } from '@n3ary/gtfs-spec/shape';
import type { Route, VehicleType } from './types';

/** VehicleType filter set used by the Stations tab's filter cascade.
 *  `undefined` means "no mode filter" — every mode is in scope. */
export type ModeFilter = ReadonlySet<VehicleType> | undefined;

/** Network id filter set used by the Stations tab's filter cascade.
 *  `undefined` means "no network filter" — every network is in scope.
 *  Empty Set means "no networks" — every station is filtered out. */
export type NetworkFilter = ReadonlySet<string> | undefined;

/** True when `route` passes the active filter sets. Mode matches if
 *  the route's `type` is in `modes` (or `modes` is undefined). Network
 *  matches if any of `route.networks` is in `networks` (or `networks`
 *  is undefined, or `route.networks` itself is undefined for feeds
 *  that pre-date networks.txt — those always pass the network
 *  filter). */
export function routeMatchesFilters(
  route: Pick<Route, 'type' | 'networks'>,
  modes: ModeFilter,
  networks: NetworkFilter,
): boolean {
  if (modes !== undefined) {
    const t = route.type ?? 'unknown';
    if (!modes.has(t)) return false;
  }
  if (networks !== undefined) {
    if (networks.size === 0) return false;
    if (route.networks === undefined) return true;
    return route.networks.some((n) => networks.has(n));
  }
  return true;
}

/** Haversine-distance from a single anchor point. Wrapper to keep the
 *  rank imports localized. */
export function distanceMeters(
  fromLat: number,
  fromLon: number,
  toLat: number | undefined,
  toLon: number | undefined,
): number {
  if (toLat == null || toLon == null) return Number.POSITIVE_INFINITY;
  return haversineMeters(fromLat, fromLon, toLat, toLon);
}