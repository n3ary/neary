// favoritesStore: persistent map of stop_id -> StationMarker, scoped to the
// current feed. Each station has at most one marker (a station's marker
// replaces any previous one for the same station); many stations can share
// the same marker type, so home / work / cityCenter are not singletons.
//
// In-memory shape: raw stop_id -> marker (same as before).
// localStorage shape: `neary:stationMarkers:{feedId}` -> JSON of
//   `{stopId: marker, ...}` (feed-qualified key).
//
// Migration: on first load of a given feed, if the legacy flat key
// `neary:stationMarkers` exists, its entries are stored under the
// feed-scoped key and the legacy key is deleted. Migration is idempotent
// (the legacy key is gone after first migration, so subsequent loads skip it).

import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { Briefcase, Crosshair, Heart, Home } from 'lucide-svelte';

const STORAGE_KEY_ROUTES = 'neary:favoriteRoutes';
const STORAGE_KEY_MARKERS_PREFIX = 'neary:stationMarkers:';
const STORAGE_KEY_MARKERS_LEGACY = 'neary:stationMarkers';

export type StationMarker = 'favorite' | 'home' | 'work' | 'cityCenter';

export const STATION_MARKERS: readonly StationMarker[] = [
  'favorite',
  'home',
  'work',
  'cityCenter',
] as const;

const _markerIcons: Record<StationMarker, any> = {
  favorite: Heart,
  home: Home,
  work: Briefcase,
  cityCenter: Crosshair,
};
export const STATION_MARKER_ICONS: Record<StationMarker, (props: any) => any> = _markerIcons;

export const STATION_MARKER_FILL: Record<StationMarker, 'currentColor' | 'none'> = {
  favorite: 'currentColor',
  home: 'none',
  work: 'none',
  cityCenter: 'none',
};

export const STATION_MARKER_ACCENT: Record<StationMarker | 'none', string> = {
  none: 'transparent',
  favorite: 'var(--color-favorite)',
  home: 'var(--color-favorite)',
  work: 'var(--color-favorite)',
  cityCenter: 'var(--color-favorite)',
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
    return arr
      .filter((x): x is string | number => typeof x === 'string' || typeof x === 'number')
      .map((x) => String(x));
  } catch {
    return [];
  }
}

/** Load markers for a specific feed from localStorage.
 *
 *  Migration: reads the legacy flat key once, stores under the feed-scoped
 *  key, and deletes the legacy key. Idempotent — if the scoped key already
 *  exists or the legacy key is gone, this is a no-op. */
function loadMarkersForFeed(feedId: string): Record<string, StationMarker> {
  if (typeof localStorage === 'undefined') return {};
  const scopedKey = `${STORAGE_KEY_MARKERS_PREFIX}${feedId}`;

  const scoped = localStorage.getItem(scopedKey);
  if (scoped) {
    try {
      const parsed: unknown = JSON.parse(scoped);
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

  // Migration: one-time lift from legacy flat key.
  const legacy = localStorage.getItem(STORAGE_KEY_MARKERS_LEGACY);
  if (legacy) {
    try {
      const parsed: unknown = JSON.parse(legacy);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      const migrated: Record<string, StationMarker> = {};
      for (const [stopId, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (isStationMarker(v)) migrated[stopId] = v;
      }
      localStorage.setItem(scopedKey, JSON.stringify(migrated));
      localStorage.removeItem(STORAGE_KEY_MARKERS_LEGACY);
      return migrated;
    } catch {
      localStorage.removeItem(STORAGE_KEY_MARKERS_LEGACY);
      return {};
    }
  }

  return {};
}

function persistMarkersForFeed(
  feedId: string,
  markers: ReadonlyMap<string, StationMarker>,
): void {
  if (typeof localStorage === 'undefined') return;
  const scopedKey = `${STORAGE_KEY_MARKERS_PREFIX}${feedId}`;
  try {
    const out: Record<string, StationMarker> = {};
    for (const [k, m] of markers) out[k] = m;
    localStorage.setItem(scopedKey, JSON.stringify(out));
  } catch {
    // Quota / disabled — silent noop.
  }
}

class FavoritesStore {
  #routes = new SvelteSet<string>(loadRoutes());

  // Station markers: raw stop_id -> marker (in-memory, no feed prefix).
  // Switching feeds swaps this map entirely.
  #markers = new SvelteMap<string, StationMarker>();
  #currentFeedId: string | null = null;

  /** Reactive, read-only view of the current feed's markers. */
  get markers(): ReadonlyMap<string, StationMarker> {
    return this.#markers;
  }

  /** Reactive, read-only view of favorited route ids. */
  get routeIds(): ReadonlySet<string> {
    return this.#routes;
  }

  // ── Feed lifecycle ─────────────────────────────────────────────

  /** Call from +layout when the feed changes (including on first bind).
   *  Loads markers for the new feed, migrating from the legacy flat key
   *  if this is the first visit to this feed. Clears the in-memory map
   *  (old feed's markers stay in localStorage under their own key). */
  loadForFeed = (feedId: string): void => {
    if (feedId === this.#currentFeedId) return;
    this.#currentFeedId = feedId;
    const loaded = loadMarkersForFeed(feedId);
    this.#markers = new SvelteMap<string, StationMarker>(
      Object.entries(loaded) as [string, StationMarker][],
    );
  };

  // ── Route favorites ────────────────────────────────────────────

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

  // ── Station markers ────────────────────────────────────────────

  /** Marker assigned to a stop in the current feed, or undefined. */
  markerFor = (stopId: string): StationMarker | undefined => this.#markers.get(stopId);

  /** True if the stop has any marker in the current feed. */
  hasMarker = (stopId: string): boolean => this.#markers.has(stopId);

  /** Raw stop ids with the given marker type. */
  stationsWithMarker = (marker: StationMarker): string[] => {
    const out: string[] = [];
    for (const [id, m] of this.#markers) {
      if (m === marker) out.push(id);
    }
    return out;
  };

  /** Apply a marker to a stop in the current feed. Pass `null` to remove. */
  setMarker = (stopId: string, marker: StationMarker | null): void => {
    if (this.#currentFeedId === null) return;
    const current = this.#markers.get(stopId);
    if (marker === null) {
      if (current === undefined) return;
      this.#markers.delete(stopId);
    } else {
      if (current === marker) return;
      this.#markers.set(stopId, marker);
    }
    persistMarkersForFeed(this.#currentFeedId, this.#markers);
  };

  /** Toggle marker for a stop. Returns the resulting marker (or undefined if removed). */
  toggleMarker = (stopId: string, marker: StationMarker): StationMarker | undefined => {
    const current = this.#markers.get(stopId);
    if (current === marker) {
      this.setMarker(stopId, null);
      return undefined;
    }
    this.setMarker(stopId, marker);
    return marker;
  };

  /** Clear all markers for the current feed. */
  clearMarkers = (): void => {
    if (this.#markers.size === 0) return;
    this.#markers.clear();
    if (this.#currentFeedId !== null) persistMarkersForFeed(this.#currentFeedId, this.#markers);
  };

  // ── Persistence ────────────────────────────────────────────────

  #persistRoutes = (): void => {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(STORAGE_KEY_ROUTES, JSON.stringify(Array.from(this.#routes)));
    } catch {
      // Quota / disabled — silent noop.
    }
  };
}

export const favoritesStore = new FavoritesStore();
export { FavoritesStore as FavoritesStoreInternal };
