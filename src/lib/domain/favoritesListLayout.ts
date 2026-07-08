// Pure list-layout helpers for the /favorites page. The page itself
// owns fetch + scroll + IntersectionObserver; this module owns
// "given the data the worker returned, what order do rows render in,
// and which ones pass the filter cascade".

import { compareRouteShortName } from './types';
import type { Route, VehicleType } from './types';
import type { StopWithDistance } from '$lib/data/gtfs/types';
import { haversineMeters } from '@n3ary/gtfs-spec/shape';
import { routeMatchesFilters } from './favoritesRanking';

/** Mode filter applied to the Stations tab. `null` = no filter. */
export type StationModeFilter = VehicleType | null;
/** Network filter applied to the Stations tab. `null` = no filter. */
export type StationNetworkFilter = string | null;

/** Decide which stations pass the filter cascade.
 *
 *  `routesThroughStation` is the worker pre-computed map: stop_id ->
 *  distinct routes that serve the stop in the feed schedule. A
 *  station passes iff at least one of its routes passes the active
 *  mode + network filters. Favorited stations are filtered
 *  separately by the caller — they're exempt from the cascade but
 *  the UI annotates them with a caption explaining why they appear
 *  despite the filter.
 *
 *  No filters active -> every station passes (preserves the
 *  pre-#237 "see everything" behavior). */
export function stationsPassingFilter(args: {
  /** All stations the page considered (favorited + the visible
   *  page's worth of "other" stations). */
  candidates: ReadonlyArray<StopWithDistance>;
  routesThroughStation: Readonly<Record<string, readonly Route[]>>;
  modeFilter: StationModeFilter;
  networkFilter: StationNetworkFilter;
}): Set<string> {
  if (args.modeFilter === null && args.networkFilter === null) {
    return new Set(args.candidates.map((s) => s.id));
  }
  const modes = args.modeFilter === null
    ? undefined
    : new Set<VehicleType>([args.modeFilter]);
  const networks = args.networkFilter === null
    ? undefined
    : new Set<string>([args.networkFilter]);
  const out = new Set<string>();
  for (const s of args.candidates) {
    const routes = args.routesThroughStation[s.id];
    if (!routes) continue;
    if (routes.some((r) => routeMatchesFilters(r, modes, networks))) {
      out.add(s.id);
    }
  }
  return out;
}

/** Sort routes for the Routes tab. Active routes float to the top,
 *  inactive ones alphabetical by shortName. */
export function sortRoutesForPicker(
  routes: readonly Route[],
  activeRouteIds: ReadonlySet<string>,
): Route[] {
  return [...routes].sort((a, b) => {
    const aActive = activeRouteIds.has(a.id) ? 0 : 1;
    const bActive = activeRouteIds.has(b.id) ? 0 : 1;
    if (aActive !== bActive) return aActive - bActive;
    return compareRouteShortName(a.shortName, b.shortName);
  });
}

/** Sort stations for the Stations tab catalog. Distance from anchor
 *  when anchor is set; localeCompare on name otherwise. Stops missing
 *  coordinates sort to the end (Infinity) regardless of mode. */
export function sortStationsForPicker(
  stations: readonly StopWithDistance[],
  anchor?: { lat: number; lon: number } | null,
): StopWithDistance[] {
  if (!anchor) {
    return [...stations].sort((a, b) => a.name.localeCompare(b.name));
  }
  return [...stations].sort((a, b) => {
    const ad = a.distance ?? (a.lat != null && a.lon != null
      ? haversineMeters(anchor.lat, anchor.lon, a.lat, a.lon)
      : Number.POSITIVE_INFINITY);
    const bd = b.distance ?? (b.lat != null && b.lon != null
      ? haversineMeters(anchor.lat, anchor.lon, b.lat, b.lon)
      : Number.POSITIVE_INFINITY);
    return ad - bd;
  });
}

/** Sort stations for the combined "Your favorites" card. Pure
 *  alphabetical on name, locale-aware. The marker type does not
 *  influence order here - home / work / cityCenter / favorite
 *  stations interleave alphabetically. Used by both the home
 *  FavoritesCard and /favorites so the same stations render in the
 *  same order wherever they appear. */
export function sortStationsAlphabetically(
  stations: readonly StopWithDistance[],
): StopWithDistance[] {
  return [...stations].sort((a, b) => a.name.localeCompare(b.name));
}

/** Parse the `?tab=` query param. Unknown values collapse to null
 *  so the caller can fall back to the default (Routes). */
export type FavoritesTab = 'routes' | 'stations';
export function parseFavoritesTab(raw: string | null | undefined): FavoritesTab | null {
  if (raw === 'routes' || raw === 'stations') return raw;
  return null;
}