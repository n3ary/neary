/*
 * favoritesStore - persistent set of favorited route + station ids.
 *
 * Single-source for "is this favorited?" reads + writes. Used by:
 *   - RouteBadge (heart pip when favorite)
 *   - StationCard (passes the route set down so each badge knows)
 *   - selectBoardsForView (favorite-route fallback when no stop is nearby)
 *   - /favorites page (lists favorite routes and stations)
 *   - Home page favorites card (lists favorite routes and stations when
 *     GPS is unavailable)
 *   - HeaderSearchOverlay (hearts on every result row, plus favorited
 *     routes + stations in empty-query mode)
 *
 * Persistence: localStorage keys `neary:favoriteRoutes` and
 * `neary:favoriteStations`, each stored as a JSON array of GTFS
 * ids (strings, matching `Route.id` and `Stop.id`). Loaded once on
 * construction (browser only), saved on every mutation. SSR-safe
 * (no-ops on the server).
 *
 * `loadInitial` is lenient about legacy entries (numbers from older
 * builds before Route.id was widened to string) and normalises them
 * to strings on read so a migrating user doesn't lose their favorites.
 */

import { SvelteSet } from 'svelte/reactivity';

const STORAGE_KEY_ROUTES = 'neary:favoriteRoutes';
const STORAGE_KEY_STATIONS = 'neary:favoriteStations';

function loadInitial(key: string): string[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(key);
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

class FavoritesStore {
  // Native reactive Sets - mutations on them propagate without any
  // reassignment dance, and consumers read through `routeIds` /
  // `stationIds` (ReadonlySet views) so they can't mutate behind our
  // back. Routes and stations are independent sets; the store doesn't
  // pretend one is a special case of the other.
  #routes = new SvelteSet<string>(loadInitial(STORAGE_KEY_ROUTES));
  #stations = new SvelteSet<string>(loadInitial(STORAGE_KEY_STATIONS));

  /** Reactive, read-only view. */
  get routeIds(): ReadonlySet<string> {
    return this.#routes;
  }

  /** Reactive, read-only view. */
  get stationIds(): ReadonlySet<string> {
    return this.#stations;
  }

  has(routeId: string): boolean {
    return this.#routes.has(routeId);
  }

  hasStation(stopId: string): boolean {
    return this.#stations.has(stopId);
  }

  add(routeId: string): void {
    if (this.#routes.has(routeId)) return;
    this.#routes.add(routeId);
    this.#persist(STORAGE_KEY_ROUTES, this.#routes);
  }

  addStation(stopId: string): void {
    if (this.#stations.has(stopId)) return;
    this.#stations.add(stopId);
    this.#persist(STORAGE_KEY_STATIONS, this.#stations);
  }

  remove(routeId: string): void {
    if (!this.#routes.has(routeId)) return;
    this.#routes.delete(routeId);
    this.#persist(STORAGE_KEY_ROUTES, this.#routes);
  }

  removeStation(stopId: string): void {
    if (!this.#stations.has(stopId)) return;
    this.#stations.delete(stopId);
    this.#persist(STORAGE_KEY_STATIONS, this.#stations);
  }

  toggle(routeId: string): void {
    if (this.has(routeId)) this.remove(routeId);
    else this.add(routeId);
  }

  toggleStation(stopId: string): void {
    if (this.hasStation(stopId)) this.removeStation(stopId);
    else this.addStation(stopId);
  }

  clear(): void {
    this.#routes.clear();
    this.#persist(STORAGE_KEY_ROUTES, this.#routes);
  }

  clearStations(): void {
    this.#stations.clear();
    this.#persist(STORAGE_KEY_STATIONS, this.#stations);
  }

  #persist(key: string, set: ReadonlySet<string>): void {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(key, JSON.stringify(Array.from(set)));
    } catch {
      // Quota / disabled — silently noop. Favorites is non-critical.
    }
  }
}

export const favoritesStore = new FavoritesStore();