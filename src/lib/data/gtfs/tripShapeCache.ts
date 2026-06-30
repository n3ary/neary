/*
 * Trip-shape + stop-distance cache helpers shared by the Stations
 * (/) and per-Station (/station/[id]) pages.
 *
 * Both pages refresh on a 15 s live-poll tick (plus manual refresh
 * + GPS-fix changes). On every refresh they need the shape polyline
 * and stop-distance array for every trip visible on the boards, so
 * the live reconciler can project GPS-based ETAs onto the right
 * polyline at intermediate stops.
 *
 * Naïve fetch-all-trips-every-tick is expensive: for Cluj's
 * Stations view that's ~250 trip_ids per refresh, marshalled across
 * the worker IPC boundary as a fresh result map each time. Chrome
 * Performance profiling on 2026-06-30 measured ~3 s of worker SQL
 * + Comlink callback time per tick from this path alone, with
 * matching 73 MB heap growth per 5 s.
 *
 * Diff fetch: only request trip_ids that aren't already in the
 * caller's cache, then prune the merged result down to the visible
 * set so the cache stays bounded across long sessions.
 */

import type { GtfsRepo } from './types';

export type TripShape = Array<{ lat: number; lon: number }>;
export type TripStopDistances = number[];

export interface TripShapeCache {
  shapes: Record<string, TripShape>;
  stopDistances: Record<string, TripStopDistances>;
}

const EMPTY_CACHE: TripShapeCache = Object.freeze({
  shapes: {},
  stopDistances: {},
}) as TripShapeCache;

export function emptyTripShapeCache(): TripShapeCache {
  return { shapes: {}, stopDistances: {} };
}

/**
 * Sync the cache for the currently-visible trip set:
 *  1. Fetch shapes + stop_distances for any trip_id in `visibleTripIds`
 *     not already present in `prev.shapes`.
 *  2. Merge into prev, then prune to only the visible set so the
 *     cache size tracks the page (not the lifetime of the session).
 *
 * Returns the new cache. Callers should assign the result to a
 * single $state variable; mutation in place would defeat Svelte 5
 * reactivity.
 */
export async function syncTripShapeCache(
  repo: GtfsRepo,
  visibleTripIds: Iterable<string>,
  prev: TripShapeCache = EMPTY_CACHE,
): Promise<TripShapeCache> {
  const visible = visibleTripIds instanceof Set ? visibleTripIds : new Set(visibleTripIds);
  const missing: string[] = [];
  for (const id of visible) {
    if (!(id in prev.shapes)) missing.push(id);
  }
  // Steady-state fast path: nothing missing AND nothing to prune.
  // Return `prev` unchanged so the caller's `state = next.shapes`
  // assignment is a no-op for Svelte 5 reactivity (same reference),
  // which breaks the feedback loop where every call would re-fire
  // any $effect that reads the shapes map. Chrome trace 2026-06-30
  // saw 184 IPC round-trips in 5.8 s and a visible per-second
  // bucket flicker before this guard was added.
  if (missing.length === 0) {
    let needsPrune = false;
    for (const id in prev.shapes) {
      if (!visible.has(id)) { needsPrune = true; break; }
    }
    if (!needsPrune) return prev;
  }
  let mergedShapes = prev.shapes;
  let mergedDist = prev.stopDistances;
  if (missing.length > 0) {
    const [extraShapes, extraDist] = await Promise.all([
      repo.getShapesForTrips(missing),
      repo.getStopDistancesForTrips(missing),
    ]);
    mergedShapes = { ...prev.shapes, ...extraShapes };
    mergedDist = { ...prev.stopDistances, ...extraDist };
  }
  // Prune to visible set: trips that left the boards (terminated,
  // user moved, route filter changed) drop out of the cache so it
  // doesn't grow unbounded.
  const prunedShapes: Record<string, TripShape> = {};
  const prunedDist: Record<string, TripStopDistances> = {};
  for (const id of visible) {
    if (mergedShapes[id]) prunedShapes[id] = mergedShapes[id];
    if (mergedDist[id]) prunedDist[id] = mergedDist[id];
  }
  return { shapes: prunedShapes, stopDistances: prunedDist };
}
