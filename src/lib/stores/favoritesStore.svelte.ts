// favoritesStore: persistent map of stop_id -> StationMarker. Each
// station has at most one marker (a station's marker replaces any
// previous one for the same station); many stations can share the
// same marker type, so home / work / cityCenter are not singletons.

import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { Briefcase, Crosshair, Heart, Home } from 'lucide-svelte';

const STORAGE_KEY_ROUTES = 'neary:favoriteRoutes';
const STORAGE_KEY_MARKERS = 'neary:stationMarkers';

export type StationMarker = 'favorite' | 'home' | 'work' | 'cityCenter';

export const STATION_MARKERS: readonly StationMarker[] = [
  'favorite',
  'home',
  'work',
  'cityCenter',
] as const;

// Single source of truth for the icon + display style per marker.
// Every marker surface (badge / dropdown option / headsign / route row /
// station header) imports this map - changing the icon here propagates
// everywhere. Same shape as the marker enum so the iteration order in
// STATION_MARKERS is the visual order.
//
// Crosshair for city center mirrors the Italian road sign "simbolo
// centro" - a circle with crosshair lines indicating the centre of a
// city/town. Visually distinct from Heart / Home / Briefcase so the
// four markers don't blur together when shown on the same row.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _markerIcons: Record<StationMarker, any> = {
  favorite: Heart,
  home: Home,
  work: Briefcase,
  cityCenter: Crosshair,
};
export const STATION_MARKER_ICONS: Record<StationMarker, (props: any) => any> = _markerIcons;

/** Whether the marker's icon should be filled or outlined. favorite
 *  fills (matches the long-standing heart fill convention); the rest
 *  read better outlined at the 12-16px sizes markers render at. */
export const STATION_MARKER_FILL: Record<StationMarker, 'currentColor' | 'none'> = {
  favorite: 'currentColor',
  home: 'none',
  work: 'none',
  cityCenter: 'none',
};

/** Accent colour for stations with a marker. Used for the left-border
 *  accent on station cards/rows and the badge icon tint. Uses CSS
 *  variables so theme.css controls the actual colour (--color-favorite
 *  for favorite, --color-primary for home/work/cityCenter). */
export const STATION_MARKER_ACCENT: Record<StationMarker | 'none', string> = {
  none: 'transparent',
  favorite: 'var(--color-favorite)',
  home: 'var(--color-primary)',
  work: 'var(--color-primary)',
  cityCenter: 'var(--color-primary)',
};

export function isStationMarker(value: unknown): value is StationMarker {
  return STATION_MARKERS.includes(value as StationMarker);
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
  // .set / .delete are reactive.
  #markers = new SvelteMap<string, StationMarker>(
    Object.entries(loadMarkers()) as [string, StationMarker][],
  );

  /** Reactive, read-only view. */
  get routeIds(): ReadonlySet<string> {
    return this.#routes;
  }

  /** Reactive, read-only view of the marker map. */
  get markers(): ReadonlyMap<string, StationMarker> {
    return this.#markers;
  }

  // Arrow class fields (initialised in the constructor with `this`
  // bound to the instance). This lets callers extract a method and
  // pass it as a callback (`favoritesStore.markerFor`) without losing
  // `this` - the arrow closes over the instance, so `this.#markers`
  // still resolves even when the method is invoked as
  // `markerFor(stopId)` from a child component. Same shape as the
  // original method-style definitions; just bound at construction.

  hasRoute = (routeId: string): boolean => this.#routes.has(routeId);

  addRoute = (routeId: string): void => {
    if (this.#routes.has(routeId)) return;
    this.#routes.add(routeId);
    this.#persistRoutes();
  };

  removeRoute = (routeId: string): void => {
    if (!this.#routes.has(routeId)) return;
    this.#routes.delete(routeId);
    this.#persistRoutes();
  };

  toggleRoute = (routeId: string): void => {
    if (this.hasRoute(routeId)) this.removeRoute(routeId);
    else this.addRoute(routeId);
  };

  clearRoutes = (): void => {
    this.#routes.clear();
    this.#persistRoutes();
  };

  // ── Station markers ───────────────────────────────────────────

  /** Marker assigned to a station, or undefined. */
  markerFor = (stopId: string): StationMarker | undefined => this.#markers.get(stopId);

  /** True if the station has any marker (favorite / home / work / cityCenter). */
  hasMarker = (stopId: string): boolean => this.#markers.has(stopId);

  /** Stop ids with the given marker. Allocates a new array; callers
   *  that read this in render paths should keep the consumer in a
   *  `$derived` so the allocation only happens on real change. */
  stationsWithMarker = (marker: StationMarker): string[] => {
    const out: string[] = [];
    for (const [id, m] of this.#markers) {
      if (m === marker) out.push(id);
    }
    return out;
  };

  /** Apply a marker to a station. Assigning the same marker a station
   *  already has is a no-op; assigning a different marker replaces
   *  the previous one for that station. Pass `null` to remove the
   *  station's marker entirely. Many stations can share the same
   *  marker type (no per-type singleton invariant). */
  setMarker = (stopId: string, marker: StationMarker | null): void => {
    const current = this.#markers.get(stopId);
    if (marker === null) {
      if (current === undefined) return;
      this.#markers.delete(stopId);
    } else {
      if (current === marker) return;
      this.#markers.set(stopId, marker);
    }
    this.#persistMarkers();
  };

  /** Toggle semantics for the heart-button dropdown: if the station
   *  currently has the given marker, remove it; otherwise assign it.
   *  Returns the station's resulting marker (undefined if cleared). */
  toggleMarker = (stopId: string, marker: StationMarker): StationMarker | undefined => {
    const current = this.#markers.get(stopId);
    if (current === marker) {
      this.setMarker(stopId, null);
      return undefined;
    }
    this.setMarker(stopId, marker);
    return marker;
  };

  /** Reset every station's marker. Tests + "clear all" UI use this. */
  clearMarkers = (): void => {
    if (this.#markers.size === 0) return;
    this.#markers.clear();
    this.#persistMarkers();
  };

  // ── Persistence ────────────────────────────────────────────────

  #persistRoutes = (): void => {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(STORAGE_KEY_ROUTES, JSON.stringify(Array.from(this.#routes)));
    } catch {
      // Quota / disabled — silent noop. Favorites is non-critical.
    }
  };

  #persistMarkers = (): void => {
    if (typeof localStorage === 'undefined') return;
    try {
      const out: Record<string, StationMarker> = {};
      for (const [id, m] of this.#markers) out[id] = m;
      localStorage.setItem(STORAGE_KEY_MARKERS, JSON.stringify(out));
    } catch {
      // Quota / disabled — silent noop.
    }
  };
}

export const favoritesStore = new FavoritesStore();
/** Exported for tests that need a clean instance after mutating the
 *  pre-load localStorage state. App code should always use the
 *  module-level singleton. */
export { FavoritesStore as FavoritesStoreInternal };