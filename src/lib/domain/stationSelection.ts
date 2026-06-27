/*
 * stationSelection — chooses which stations the Stations view should
 * surface for a given GPS context. Pure, no DOM, no SQL.
 *
 * Rules (spec: docs/specs/vehicles-and-views.md):
 *
 *   1. PRIMARY — closest stop within `nearbyRadiusM`. If a second
 *      stop is also within `nearbyRadiusM` AND its distance to the user
 *      is within `pairProximityM` of the closest, surface it too (the
 *      "I'm standing between two stops" case).
 *   2. WIDER FALLBACK — if nothing satisfies (1), surface ONE stop
 *      within `favoriteFallbackRadiusM`:
 *         a) closest stop on a favorited route (when favorites exist), OR
 *         b) closest stop overall (when no favorites match or are set).
 *      Avoids the "No nearby stations" dead end when stops exist a
 *      few hundred meters past `nearbyRadiusM`.
 *   3. Otherwise return [].
 *
 * The closest returned stop is also designated `expandedStopId` so the
 * Stations view can auto-expand it.
 *
 * The selector takes already-fetched boards (`{stop, vehicles}[]`) so
 * the favorite-fallback can inspect what routes serve each stop without
 * needing a second worker round-trip. Caller is responsible for
 * passing a candidate set wide enough to cover BOTH the nearby and the
 * favorite-fallback radii — i.e. query with the larger of the two.
 *
 * Why here and not in the page: the route shape "view of stations" is
 * a domain concept (which stops should the user see?). The /stations
 * page is one consumer; a future map-based "tap to inspect a stop"
 * view skips the selector entirely and passes a single stop in
 * directly. Keeping the rule pure means we can A/B different
 * selection policies (always-pair vs strict-nearest vs
 * favorites-priority) by swapping which function the page calls.
 */

import type { NearyConfig } from './config';
import type { Vehicle } from './types';

export interface StationBoardCandidate<S> {
  stop: S;
  vehicles: Vehicle[];
}

/** Minimum shape we need from a `Stop` to run selection. The repo's
 *  StopWithDistance satisfies this. */
export interface SelectableStop {
  id: number;
  distance?: number;
}

export interface SelectionInputs<S extends SelectableStop> {
  /** Boards from `repo.getStationBoardsNear`. MUST be pre-sorted by
   *  `stop.distance` ascending (the worker already does this). */
  candidates: StationBoardCandidate<S>[];
  /** Tunable knobs — see NearyConfig. */
  config: Pick<NearyConfig, 'nearbyRadiusM' | 'pairProximityM' | 'favoriteFallbackRadiusM'>;
  /** Routes the user has favorited. Pass `null` until the favorites
   *  store exists — the favorite-fallback step is a no-op. GTFS
   *  route_ids are text per the spec (Cluj has '102L'); we store and
   *  compare them as strings end-to-end. */
  favoriteRouteIds: ReadonlySet<string> | null;
}

export interface SelectionResult<S extends SelectableStop> {
  /** Stations to display, in distance order. Length 0–2 in primary
   *  mode, 0–1 in favorite-fallback mode. */
  boards: StationBoardCandidate<S>[];
  /** Stop id that the view should auto-expand. Always the closest of
   *  whatever `boards` contains; null when boards is empty. */
  expandedStopId: number | null;
}

export function selectBoardsForView<S extends SelectableStop>(
  inputs: SelectionInputs<S>,
): SelectionResult<S> {
  const { candidates, config, favoriteRouteIds } = inputs;

  // (1) Primary: closest within nearbyRadiusM, optionally paired with
  // the very next one if it's only ~pairProximityM further away.
  const nearby = candidates.filter(
    (c) => typeof c.stop.distance === 'number' && c.stop.distance <= config.nearbyRadiusM,
  );
  if (nearby.length > 0) {
    const closest = nearby[0];
    const second = nearby[1];
    const closestDist = closest.stop.distance ?? Infinity;
    const secondDist = second?.stop.distance ?? Infinity;
    const paired = second && (secondDist - closestDist) <= config.pairProximityM;
    const boards = paired ? [closest, second] : [closest];
    return { boards, expandedStopId: closest.stop.id };
  }

  // (2) Wider fallback — surface ONE stop within favoriteFallbackRadiusM.
  // Prefer a favorited route when the user has any; otherwise just take
  // the closest stop. Prevents the empty "No nearby stations" state in
  // the common case of a user standing a few hundred meters past the
  // primary radius.
  const wide = candidates.filter(
    (c) => typeof c.stop.distance === 'number' && c.stop.distance <= config.favoriteFallbackRadiusM,
  );
  if (wide.length === 0) return { boards: [], expandedStopId: null };

  if (favoriteRouteIds && favoriteRouteIds.size > 0) {
    for (const c of wide) {
      if (c.vehicles.some((v) => favoriteRouteIds.has(v.route.id))) {
        return { boards: [c], expandedStopId: c.stop.id };
      }
    }
  }
  // No favorited match (or no favorites set) — fall through to the
  // closest stop in the wider radius.
  const closestWide = wide[0];
  return { boards: [closestWide], expandedStopId: closestWide.stop.id };
}
