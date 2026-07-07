// Choose which stops the Stations view should surface. Pure, no DOM/SQL. Spec: docs/specs/vehicles-and-views.md.

import type { NearyConfig } from './config';
import type { Vehicle } from './types';

export interface StationBoardCandidate<S> {
  stop: S;
  vehicles: Vehicle[];
}

/** Minimum Stop shape for selection. StopWithDistance satisfies this. */
export interface SelectableStop {
  id: string;
  distance?: number;
}

export interface SelectionInputs<S extends SelectableStop> {
  /** From `repo.getStationBoardsNear`. MUST be pre-sorted by `stop.distance` ascending. */
  candidates: StationBoardCandidate<S>[];
  config: Pick<NearyConfig, 'nearbyRadiusM' | 'pairProximityM' | 'favoriteFallbackRadiusM'>;
  /** Pass `null` until the favorites store exists — the favorite-fallback step is a no-op. GTFS route_ids are text per spec (some feeds ship '102L'-style ids); compare as strings. */
  favoriteRouteIds: ReadonlySet<string> | null;
}

export interface SelectionResult<S extends SelectableStop> {
  /** In distance order. Length 0-2 in primary mode, 0-1 in favorite-fallback mode. */
  boards: StationBoardCandidate<S>[];
  /** Stop id the view should auto-expand. null when boards is empty. */
  expandedStopId: string | null;
}

export function selectBoardsForView<S extends SelectableStop>(
  inputs: SelectionInputs<S>,
): SelectionResult<S> {
  const { candidates, config, favoriteRouteIds } = inputs;

  // (1) Primary: closest within nearbyRadiusM, optionally paired with the next if within pairProximityM
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

  // (2) Wider fallback — closest stop within favoriteFallbackRadiusM; prefer a favorited route when the user has any
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
  return { boards: [wide[0]], expandedStopId: wide[0].stop.id };
}
