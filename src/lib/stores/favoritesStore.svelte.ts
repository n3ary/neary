// favoritesStore: persistent map of stop_id -> StationMarker, plus
// the singleton tracking fields for home / work / cityCenter. Each
// station has at most one marker; a station's marker replaces any
// previous one for the same station. The "single home / work /
// cityCenter" invariants are enforced here, not at the call site.

import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { userPrefs } from './userPrefs.svelte';

const STORAGE_KEY_ROUTES = 'neary:favoriteRoutes';
const STORAGE_KEY_MARKERS = 'neary:stationMarkers';

export type StationMarker = 'favorite' | 'home' | 'work' | 'cityCenter';

export const STATION_MARKERS: readonly StationMarker[] = [
  'favorite',
  'home',
  'work',
  'cityCenter',
] as const;

export function isStationMarker(value: unknown): value is StationMarker {
  return value === 'favorite' || value === 'home' || value === 'work' || value === 'cityCenter';
}

function loadRoutes(): string[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY_ROUTES);
    if (!raw) return [];
    const arr: unknown = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    // Tolerate legacy number entries so migrating users keep their
    // favorites; everything new is written as a string.
    return arr
      .filter((x): x is string | number => typeof x === 'string' || typeof x === 'number')
      .map((x) => String(x));
  } catch {
    return [];
  }
}

function loadMarkers(): Record<string, StationMarker> {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY_MARKERS);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, StationMarker> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (isStationMarker(v)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

class FavoritesStore {
  // Native reactive Set for routes. Mutations propagate without any
  // reassignment dance, and consumers read through `routeIds`
  // (ReadonlySet view) so they can't mutate behind our back.
  #routes = new SvelteSet<string>(loadRoutes());

  // Station markers: stop_id -> StationMarker. Native SvelteMap so
  // .set / .delete are reactive. The singleton fields below are
  // derived (or could be) but we keep them as separate get accessors
  // for type-safe single-value queries without the map lookup.
  #markers = new SvelteMap<string, StationMarker>(
    Object.entries(loadMarkers()) as [string, StationMarker][],
  );

  /** Reactive, read-only view. */
  get routeIds(): ReadonlySet<string> {
    return this.#routes;
  }

  hasRoute(routeId: string): boolean {
    return this.#routes.has(routeId);
  }

  addRoute(routeId: string): void {
    if (this.#routes.has(routeId)) return;
    this.#routes.add(routeId);
    this.#persistRoutes();
    userPrefs.lastRouteMarkedAt = Date.now();
  }

  removeRoute(routeId: string): void {
    if (!this.#routes.has(routeId)) return;
    this.#routes.delete(routeId);
    this.#persistRoutes();
  }

  toggleRoute(routeId: string): void {
    if (this.hasRoute(routeId)) this.removeRoute(routeId);
    else this.addRoute(routeId);
  }

  clearRoutes(): void {
    this.#routes.clear();
    this.#persistRoutes();
  }

  // ── Station markers ───────────────────────────────────────────

  /** Reactive, read-only view of the marker map. */
  get markers(): ReadonlyMap<string, StationMarker> {
    return this.#markers;
  }

  /** Marker assigned to a station, or undefined. */
  markerFor(stopId: string): StationMarker | undefined {
    return this.#markers.get(stopId);
  }

  /** True if the station has any marker (favorite / home / work / cityCenter). */
  hasMarker(stopId: string): boolean {
    return this.#markers.has(stopId);
  }

  /** Stop ids with the given marker. Allocates a new array; callers
   *  that read this in render paths should keep the consumer in a
   *  `$derived` so the allocation only happens on real change. */
  stationsWithMarker(marker: StationMarker): string[] {
    const out: string[] = [];
    for (const [id, m] of this.#markers) {
      if (m === marker) out.push(id);
    }
    return out;
  }

  /** The home station id, if one is set. */
  get homeStationId(): string | undefined {
    return this.#markers.get('__singleton__home__' as never) as never;
  }

  /** Internal: find the station that currently holds a given singleton marker. */
  #findSingleton(marker: 'home' | 'work' | 'cityCenter'): string | undefined {
    for (const [id, m] of this.#markers) {
      if (m === marker) return id;
    }
    return undefined;
  }

  /** Apply a marker to a station. For singleton markers (home / work /
   *  cityCenter), the previous owner of the same type is cleared.
   *  Assigning the same marker a station already has is a no-op.
   *  Pass `null` to remove a station's marker entirely. */
  setMarker(stopId: string, marker: StationMarker | null): void {
    const current = this.#markers.get(stopId);
    if (marker === null) {
      if (current === undefined) return;
      this.#markers.delete(stopId);
    } else {
      if (current === marker) return;
      // Singleton invariants: at most one home, one work, one cityCenter.
      if (marker !== 'favorite') {
        const previousOwner = this.#findSingleton(marker);
        if (previousOwner && previousOwner !== stopId) {
          this.#markers.delete(previousOwner);
        }
      }
      this.#markers.set(stopId, marker);
    }
    this.#persistMarkers();
    userPrefs.lastStationMarkerAssignedAt = Date.now();
  }

  /** Toggle semantics for the heart-button dropdown: if the station
   *  currently has the given marker, remove it; otherwise assign it.
   *  Returns the station's resulting marker (undefined if cleared). */
  toggleMarker(stopId: string, marker: StationMarker): StationMarker | undefined {
    const current = this.#markers.get(stopId);
    if (current === marker) {
      this.setMarker(stopId, null);
      return undefined;
    }
    this.setMarker(stopId, marker);
    return marker;
  }

  /** Reset every station's marker. Tests + "clear all" UI use this. */
  clearMarkers(): void {
    if (this.#markers.size === 0) return;
    this.#markers.clear();
    this.#persistMarkers();
  }

  // ── Persistence ────────────────────────────────────────────────

  #persistRoutes(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(STORAGE_KEY_ROUTES, JSON.stringify(Array.from(this.#routes)));
    } catch {
      // Quota / disabled — silent noop. Favorites is non-critical.
    }
  }

  #persistMarkers(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      const out: Record<string, StationMarker> = {};
      for (const [id, m] of this.#markers) out[id] = m;
      localStorage.setItem(STORAGE_KEY_MARKERS, JSON.stringify(out));
    } catch {
      // Quota / disabled — silent noop.
    }
  }
}

export const favoritesStore = new FavoritesStore();
/** Exported for tests that need a clean instance after mutating the
 *  pre-load localStorage state. App code should always use the
 *  module-level singleton. */
export { FavoritesStore as FavoritesStoreInternal };