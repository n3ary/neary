/*
 * favoritesStore — persistent set of route ids the user has starred.
 *
 * Single-source for "is this route a favorite?" reads + writes. Used by:
 *   - RouteBadge (heart pip when favorite)
 *   - StationCard (passes the set down so each badge knows)
 *   - selectBoardsForView (favorite fallback when no stop is nearby)
 *   - /favorites page (lists favorite routes)
 *
 * Persistence: localStorage key `neary:favoriteRoutes`, stored as a
 * JSON array of route ids. Loaded once on construction (browser only),
 * saved on every mutation. SSR-safe (no-ops on the server).
 *
 * Implementation: a `SvelteSet` from svelte/reactivity. We previously
 * wrapped a plain Set in `$state` and reassigned on every mutation
 * (`this.#routes = new Set(this.#routes).add(id)`). That worked for
 * UI re-renders but tripped a Svelte 5 quirk where the reassignment
 * happened before the rune finished tracking, so consumers
 * occasionally saw stale data — including after a reload, where the
 * persisted value looked unchanged. SvelteSet's `.add` / `.delete`
 * fire reactivity natively and avoid the in-flight copy entirely.
 */

import { SvelteSet } from 'svelte/reactivity';

const STORAGE_KEY = 'neary:favoriteRoutes';

function loadInitial(): number[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const arr: unknown = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  } catch {
    return [];
  }
}

class FavoritesStore {
  // Native reactive Set — mutations on it propagate without any
  // reassignment dance, and consumers read through `routeIds` (a
  // ReadonlySet view) so they can't mutate behind our back.
  #routes = new SvelteSet<number>(loadInitial());

  /** Reactive, read-only view. */
  get routeIds(): ReadonlySet<number> {
    return this.#routes;
  }

  has(routeId: number): boolean {
    return this.#routes.has(routeId);
  }

  add(routeId: number): void {
    if (this.#routes.has(routeId)) return;
    this.#routes.add(routeId);
    this.#persist();
  }

  remove(routeId: number): void {
    if (!this.#routes.has(routeId)) return;
    this.#routes.delete(routeId);
    this.#persist();
  }

  toggle(routeId: number): void {
    if (this.#routes.has(routeId)) this.remove(routeId);
    else this.add(routeId);
  }

  clear(): void {
    this.#routes.clear();
    this.#persist();
  }

  #persist(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(this.#routes)));
    } catch {
      // Quota / disabled — silently noop. Favorites is non-critical.
    }
  }
}

export const favoritesStore = new FavoritesStore();
