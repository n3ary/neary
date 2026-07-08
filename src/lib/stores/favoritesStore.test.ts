import { describe, expect, it, beforeEach } from 'vitest';
import { favoritesStore, FavoritesStoreInternal } from './favoritesStore.svelte';

// favoritesStore persists to localStorage. The vitest config doesn't
// pin an environment, so node runs by default with no localStorage
// global. Stub the API with an in-memory Map so the persistence
// assertions stay meaningful without pulling in jsdom.
const memStore = new Map<string, string>();
beforeEach(() => {
  memStore.clear();
  (globalThis as { localStorage?: Storage }).localStorage = {
    getItem: (k: string) => memStore.get(k) ?? null,
    setItem: (k: string, v: string) => { memStore.set(k, v); },
    removeItem: (k: string) => { memStore.delete(k); },
    clear: () => memStore.clear(),
    key: (i: number) => Array.from(memStore.keys())[i] ?? null,
    get length() { return memStore.size; },
  } as Storage;
});

describe('favoritesStore routes', () => {
  beforeEach(() => {
    favoritesStore.clearRoutes();
    favoritesStore.clearMarkers();
    localStorage.clear();
  });

  it('starts empty', () => {
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
  beforeEach(() => {
    favoritesStore.clearRoutes();
    favoritesStore.clearMarkers();
    localStorage.clear();
  });

  it('starts empty', () => {
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

  it('stationIds -> markers: route set stays separate', () => {
    favoritesStore.addRoute('r-1');
    favoritesStore.setMarker('s-1', 'favorite');
    expect(Array.from(favoritesStore.routeIds)).toEqual(['r-1']);
    expect(favoritesStore.markers.size).toBe(1);
  });

  it('persists to a separate localStorage key from routes', () => {
    favoritesStore.addRoute('r-1');
    favoritesStore.setMarker('s-1', 'favorite');
    expect(JSON.parse(localStorage.getItem('neary:favoriteRoutes') ?? '[]')).toEqual(['r-1']);
    expect(JSON.parse(localStorage.getItem('neary:stationMarkers') ?? '{}')).toEqual({ 's-1': 'favorite' });
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
});

describe('favoritesStore loadInitial', () => {
  beforeEach(() => {
    favoritesStore.clearRoutes();
    favoritesStore.clearMarkers();
    localStorage.clear();
  });

  it('reads the new key directly when present', () => {
    localStorage.setItem('neary:stationMarkers', JSON.stringify({ 's-1': 'home', 's-2': 'favorite' }));
    const fresh = new FavoritesStoreInternal();
    expect(fresh.markerFor('s-1')).toBe('home');
    expect(fresh.markerFor('s-2')).toBe('favorite');
  });

  it('tolerates malformed localStorage without throwing on next write', () => {
    localStorage.setItem('neary:stationMarkers', '{not json');
    favoritesStore.setMarker('s-1', 'favorite');
    expect(JSON.parse(localStorage.getItem('neary:stationMarkers') ?? '{}')).toEqual({ 's-1': 'favorite' });
  });
});