import { describe, expect, it, beforeEach } from 'vitest';
import { favoritesStore } from './favoritesStore.svelte';

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
    favoritesStore.clear();
    favoritesStore.clearStations();
    localStorage.clear();
  });

  it('starts empty', () => {
    expect(favoritesStore.routeIds.size).toBe(0);
  });

  it('add / has / remove', () => {
    favoritesStore.add('r-1');
    expect(favoritesStore.has('r-1')).toBe(true);
    favoritesStore.remove('r-1');
    expect(favoritesStore.has('r-1')).toBe(false);
  });

  it('toggle flips both ways', () => {
    favoritesStore.toggle('r-1');
    expect(favoritesStore.has('r-1')).toBe(true);
    favoritesStore.toggle('r-1');
    expect(favoritesStore.has('r-1')).toBe(false);
  });

  it('add is idempotent', () => {
    favoritesStore.add('r-1');
    favoritesStore.add('r-1');
    expect(Array.from(favoritesStore.routeIds)).toEqual(['r-1']);
  });

  it('remove on missing id is a noop', () => {
    favoritesStore.remove('r-1');
    expect(favoritesStore.routeIds.size).toBe(0);
  });

  it('persists to localStorage on mutation', () => {
    favoritesStore.add('r-1');
    favoritesStore.add('r-2');
    const raw = localStorage.getItem('neary:favoriteRoutes');
    expect(JSON.parse(raw ?? '[]')).toEqual(['r-1', 'r-2']);
  });
});

describe('favoritesStore stations', () => {
  beforeEach(() => {
    favoritesStore.clear();
    favoritesStore.clearStations();
    localStorage.clear();
  });

  it('starts empty and independent of routes', () => {
    favoritesStore.add('r-1');
    expect(favoritesStore.stationIds.size).toBe(0);
    expect(favoritesStore.routeIds.size).toBe(1);
  });

  it('addStation / hasStation / removeStation', () => {
    favoritesStore.addStation('s-1');
    expect(favoritesStore.hasStation('s-1')).toBe(true);
    favoritesStore.removeStation('s-1');
    expect(favoritesStore.hasStation('s-1')).toBe(false);
  });

  it('toggleStation flips both ways', () => {
    favoritesStore.toggleStation('s-1');
    expect(favoritesStore.hasStation('s-1')).toBe(true);
    favoritesStore.toggleStation('s-1');
    expect(favoritesStore.hasStation('s-1')).toBe(false);
  });

  it('station methods do not touch the route set', () => {
    favoritesStore.add('r-1');
    favoritesStore.toggleStation('s-1');
    favoritesStore.toggleStation('s-2');
    favoritesStore.removeStation('s-1');
    expect(Array.from(favoritesStore.routeIds)).toEqual(['r-1']);
    expect(Array.from(favoritesStore.stationIds)).toEqual(['s-2']);
  });

  it('persists to a separate localStorage key', () => {
    favoritesStore.add('r-1');
    favoritesStore.addStation('s-1');
    expect(JSON.parse(localStorage.getItem('neary:favoriteRoutes') ?? '[]')).toEqual(['r-1']);
    expect(JSON.parse(localStorage.getItem('neary:favoriteStations') ?? '[]')).toEqual(['s-1']);
  });

  it('clearStations leaves routes intact', () => {
    favoritesStore.add('r-1');
    favoritesStore.addStation('s-1');
    favoritesStore.clearStations();
    expect(favoritesStore.stationIds.size).toBe(0);
    expect(Array.from(favoritesStore.routeIds)).toEqual(['r-1']);
  });
});

describe('favoritesStore loadInitial (legacy migration)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('persists after a fresh write', () => {
    favoritesStore.clear();
    favoritesStore.add('r-1');
    favoritesStore.add('r-2');
    expect(JSON.parse(localStorage.getItem('neary:favoriteRoutes') ?? '[]'))
      .toEqual(['r-1', 'r-2']);
  });

  it('normalises legacy numeric entries to strings via write path', () => {
    favoritesStore.clear();
    favoritesStore.add('1');
    favoritesStore.add('2');
    favoritesStore.add('3');
    expect(Array.from(favoritesStore.routeIds).sort()).toEqual(['1', '2', '3']);
  });

  it('tolerates malformed localStorage without throwing on next write', () => {
    localStorage.setItem('neary:favoriteRoutes', '{not json');
    favoritesStore.clear();
    favoritesStore.add('r-1');
    expect(JSON.parse(localStorage.getItem('neary:favoriteRoutes') ?? '[]'))
      .toEqual(['r-1']);
  });
});