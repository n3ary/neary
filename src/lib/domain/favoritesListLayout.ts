// Pure list-layout helpers for the /favorites page. The page itself
// owns fetch + scroll + IntersectionObserver; this module owns
// "given the data the worker returned, what order do rows render in,
// and which tab the user is on".

import { compareRouteShortName } from './types';
import type { Route } from './types';
import { haversineMeters } from '@n3ary/gtfs-spec/shape';

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

/** Minimal shape required by the sort helpers — callers pass in
 *  `StopWithDistance[]` (or anything with the same field set). */
type SortableStation = {
  id: string;
  name: string;
  lat?: number;
  lon?: number;
  distance?: number;
};

/** Sort stations for the Stations tab catalog. Distance from anchor
 *  when anchor is set; localeCompare on name otherwise. Stops missing
 *  coordinates sort to the end (Infinity) regardless of mode. */
export function sortStationsForPicker<T extends SortableStation>(
  stations: readonly T[],
  anchor?: { lat: number; lon: number } | null,
): T[] {
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
export function sortStationsAlphabetically<T extends { name: string }>(
  stations: readonly T[],
): T[] {
  return [...stations].sort((a, b) => a.name.localeCompare(b.name));
}

/** Parse the `?tab=` query param. Unknown values collapse to null
 *  so the caller can fall back to the default (Routes). */
export type FavoritesTab = 'routes' | 'stations';
export function parseFavoritesTab(raw: string | null | undefined): FavoritesTab | null {
  if (raw === 'routes' || raw === 'stations') return raw;
  return null;
}
