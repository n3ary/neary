import { describe, expect, it, beforeEach } from 'vitest';
import { favoritesStore, FavoritesStoreInternal } from './favoritesStore.svelte';

// In-memory localStorage shim for isolated test runs.
const memStore = new Map<string, string>();
function useMemStore() {
  (globalThis as { localStorage?: Storage }).localStorage = {
    getItem: (k: string) => memStore.get(k) ?? null,
    setItem: (k: string, v: string) => { memStore.set(k, v); },
    removeItem: (k: string) => { memStore.delete(k); },
    clear: () => memStore.clear(),
    key: (i: number) => Array.from(memStore.keys())[i] ?? null,
    get length() { return memStore.size; },
  } as Storage;
}
useMemStore();

beforeEach(() => {
  memStore.clear();
  // Reset the singleton to a clean state for each test.
  favoritesStore.clearRoutes();
  favoritesStore.clearMarkers();
  // Reload for a fresh feed so the store starts empty.
  favoritesStore.loadForFeed('test-feed');
});

describe('favoritesStore routes', () => {
  it('starts empty for a fresh feed', () => {
    expect(favoritesStore.routeIds.size).toBe(0);
  });

  it('addRoute / hasRoute / removeRoute', () => {
    favoritesStore.addRoute('r-1');
    expect(favoritesStore.hasRoute('r-1')).toBe(true);
    favoritesStore.removeRoute('r-1');
    expect(favoritesStore.hasRoute('r-1')).toBe(false);
  });

  it('toggleRoute flips both ways', () => {
    favoritesStore.toggleRoute('r-1');
    expect(favoritesStore.hasRoute('r-1')).toBe(true);
    favoritesStore.toggleRoute('r-1');
    expect(favoritesStore.hasRoute('r-1')).toBe(false);
  });

  it('addRoute is idempotent', () => {
    favoritesStore.addRoute('r-1');
    favoritesStore.addRoute('r-1');
    expect(Array.from(favoritesStore.routeIds)).toEqual(['r-1']);
  });

  it('removeRoute on missing id is a noop', () => {
    favoritesStore.removeRoute('r-1');
    expect(favoritesStore.routeIds.size).toBe(0);
  });

  it('persists to localStorage on mutation', () => {
    favoritesStore.addRoute('r-1');
    favoritesStore.addRoute('r-2');
    const raw = localStorage.getItem('neary:favoriteRoutes');
    expect(JSON.parse(raw ?? '[]')).toEqual(['r-1', 'r-2']);
  });
});

describe('favoritesStore station markers', () => {
  it('starts empty for a fresh feed', () => {
    expect(favoritesStore.markers.size).toBe(0);
  });

  it('setMarker assigns the given type', () => {
    favoritesStore.setMarker('s-1', 'favorite');
    expect(favoritesStore.markerFor('s-1')).toBe('favorite');
    expect(favoritesStore.hasMarker('s-1')).toBe(true);
  });

  it('setMarker with null clears the marker', () => {
    favoritesStore.setMarker('s-1', 'favorite');
    favoritesStore.setMarker('s-1', null);
    expect(favoritesStore.markerFor('s-1')).toBeUndefined();
    expect(favoritesStore.hasMarker('s-1')).toBe(false);
  });

  it('setMarker replaces a previous marker on the same station', () => {
    favoritesStore.setMarker('s-1', 'favorite');
    favoritesStore.setMarker('s-1', 'home');
    expect(favoritesStore.markerFor('s-1')).toBe('home');
  });

  it('many stations can share the home marker', () => {
    favoritesStore.setMarker('s-1', 'home');
    favoritesStore.setMarker('s-2', 'home');
    favoritesStore.setMarker('s-3', 'home');
    expect(favoritesStore.markerFor('s-1')).toBe('home');
    expect(favoritesStore.markerFor('s-2')).toBe('home');
    expect(favoritesStore.markerFor('s-3')).toBe('home');
    expect(favoritesStore.markers.size).toBe(3);
  });

  it('many stations can share the work marker', () => {
    favoritesStore.setMarker('s-1', 'work');
    favoritesStore.setMarker('s-2', 'work');
    expect(favoritesStore.markerFor('s-1')).toBe('work');
    expect(favoritesStore.markerFor('s-2')).toBe('work');
  });

  it('many stations can share the cityCenter marker', () => {
    favoritesStore.setMarker('s-1', 'cityCenter');
    favoritesStore.setMarker('s-2', 'cityCenter');
    expect(favoritesStore.markerFor('s-1')).toBe('cityCenter');
    expect(favoritesStore.markerFor('s-2')).toBe('cityCenter');
  });

  it('favorite has no count limit', () => {
    favoritesStore.setMarker('s-1', 'favorite');
    favoritesStore.setMarker('s-2', 'favorite');
    favoritesStore.setMarker('s-3', 'favorite');
    expect(favoritesStore.markers.size).toBe(3);
  });

  it('toggleMarker same-type removes', () => {
    favoritesStore.toggleMarker('s-1', 'favorite');
    expect(favoritesStore.markerFor('s-1')).toBe('favorite');
    favoritesStore.toggleMarker('s-1', 'favorite');
    expect(favoritesStore.markerFor('s-1')).toBeUndefined();
  });

  it('toggleMarker different-type reassigns without evicting other stations', () => {
    favoritesStore.toggleMarker('s-1', 'home');
    favoritesStore.toggleMarker('s-2', 'home');
    expect(favoritesStore.markerFor('s-1')).toBe('home');
    expect(favoritesStore.markerFor('s-2')).toBe('home');
  });

  it('stationsWithMarker filters by type', () => {
    favoritesStore.setMarker('s-1', 'home');
    favoritesStore.setMarker('s-2', 'work');
    favoritesStore.setMarker('s-3', 'favorite');
    expect(favoritesStore.stationsWithMarker('home').sort()).toEqual(['s-1']);
    expect(favoritesStore.stationsWithMarker('work').sort()).toEqual(['s-2']);
    expect(favoritesStore.stationsWithMarker('favorite').sort()).toEqual(['s-3']);
    expect(favoritesStore.stationsWithMarker('cityCenter')).toEqual([]);
  });

  it('route set stays separate from markers', () => {
    favoritesStore.addRoute('r-1');
    favoritesStore.setMarker('s-1', 'favorite');
    expect(Array.from(favoritesStore.routeIds)).toEqual(['r-1']);
    expect(favoritesStore.markers.size).toBe(1);
  });

  it('persists under a feed-scoped key', () => {
    favoritesStore.setMarker('s-1', 'favorite');
    const raw = localStorage.getItem('neary:stationMarkers:test-feed');
    expect(JSON.parse(raw ?? '{}')).toEqual({ 's-1': 'favorite' });
  });

  it('does NOT persist to the legacy flat key', () => {
    favoritesStore.setMarker('s-1', 'favorite');
    expect(localStorage.getItem('neary:stationMarkers')).toBeNull();
  });
});

describe('favoritesStore feed scoping', () => {
  it('markers are isolated per feed', () => {
    favoritesStore.setMarker('s-1', 'favorite');
    // Switch to a different feed.
    favoritesStore.loadForFeed('other-feed');
    // No markers for the new feed yet.
    expect(favoritesStore.markers.size).toBe(0);
    expect(favoritesStore.markerFor('s-1')).toBeUndefined();
    // Mark a station in the new feed.
    favoritesStore.setMarker('s-2', 'home');
    expect(favoritesStore.markerFor('s-2')).toBe('home');
    // Original feed's markers are still in localStorage.
    const raw = localStorage.getItem('neary:stationMarkers:test-feed');
    expect(JSON.parse(raw ?? '{}')).toEqual({ 's-1': 'favorite' });
    // Switch back to the original feed — markers restored.
    favoritesStore.loadForFeed('test-feed');
    expect(favoritesStore.markerFor('s-1')).toBe('favorite');
    expect(favoritesStore.markerFor('s-2')).toBeUndefined();
  });

  it('loadForFeed is idempotent (safe to call twice)', () => {
    favoritesStore.setMarker('s-1', 'favorite');
    favoritesStore.loadForFeed('test-feed');
    expect(favoritesStore.markerFor('s-1')).toBe('favorite');
    favoritesStore.loadForFeed('test-feed');
    expect(favoritesStore.markerFor('s-1')).toBe('favorite');
  });

  it('migration: legacy flat key is lifted to feed-scoped key', () => {
    // Simulate the old flat-format data that existed before the fix.
    localStorage.setItem('neary:stationMarkers', JSON.stringify({
      's-old': 'favorite',
      's-work': 'work',
    }));
    // Load for a feed — triggers one-time migration.
    favoritesStore.loadForFeed('migrated-feed');
    expect(favoritesStore.markerFor('s-old')).toBe('favorite');
    expect(favoritesStore.markerFor('s-work')).toBe('work');
    // Legacy key is deleted after migration.
    expect(localStorage.getItem('neary:stationMarkers')).toBeNull();
    // Data is stored under the feed-scoped key.
    const raw = localStorage.getItem('neary:stationMarkers:migrated-feed');
    expect(JSON.parse(raw ?? '{}')).toEqual({
      's-old': 'favorite',
      's-work': 'work',
    });
  });

  it('migration is idempotent (does not re-read legacy key after first migration)', () => {
    // Simulate partial migration: legacy gone, feed-scoped already has some data.
    localStorage.setItem('neary:stationMarkers:migrated-feed', JSON.stringify({
      's-existing': 'cityCenter',
    }));
    // No legacy key — migration is skipped.
    favoritesStore.loadForFeed('migrated-feed');
    expect(favoritesStore.markerFor('s-existing')).toBe('cityCenter');
    // Legacy key should not appear.
    expect(localStorage.getItem('neary:stationMarkers')).toBeNull();
  });

  it('clearMarkers only clears the current feed', () => {
    favoritesStore.setMarker('s-1', 'favorite');
    favoritesStore.loadForFeed('other-feed');
    favoritesStore.setMarker('s-2', 'home');
    favoritesStore.clearMarkers();
    expect(favoritesStore.markers.size).toBe(0);
    // Original feed's markers survived.
    favoritesStore.loadForFeed('test-feed');
    expect(favoritesStore.markerFor('s-1')).toBe('favorite');
  });

  it('setMarker is a noop when no feed is loaded', async () => {
    // Create a fresh store instance (bypasses the module singleton) so we
    // can test the no-feed guard without depending on beforeEach setup.
    const { FavoritesStoreInternal } = await import('./favoritesStore.svelte');
    const freshStore = new FavoritesStoreInternal();
    // #currentFeedId is null by default — setMarker must not throw.
    freshStore.setMarker('s-1', 'favorite');
    expect(freshStore.markerFor('s-1')).toBeUndefined();
  });
});

describe('favoritesStore loadInitial (legacy compat)', () => {
  beforeEach(() => {
    favoritesStore.clearRoutes();
    favoritesStore.clearMarkers();
    favoritesStore.loadForFeed('test-feed');
  });

  it('reads the feed-scoped key directly when present', () => {
    localStorage.setItem('neary:stationMarkers:test-feed', JSON.stringify({ 's-1': 'home', 's-2': 'favorite' }));
    const fresh = new FavoritesStoreInternal();
    fresh.loadForFeed('test-feed');
    expect(fresh.markerFor('s-1')).toBe('home');
    expect(fresh.markerFor('s-2')).toBe('favorite');
  });

  it('tolerates malformed localStorage without throwing on next write', () => {
    localStorage.setItem('neary:stationMarkers:test-feed', '{not json');
    favoritesStore.setMarker('s-1', 'favorite');
    expect(JSON.parse(localStorage.getItem('neary:stationMarkers:test-feed') ?? '{}')).toEqual({ 's-1': 'favorite' });
  });
});
