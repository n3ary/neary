import { describe, expect, it } from 'vitest';
import {
  parseFavoritesTab,
  sortRoutesForPicker,
  sortStationsForPicker,
  stationsPassingFilter,
} from './favoritesListLayout';
import type { Route } from './types';
import type { StopWithDistance } from '$lib/data/gtfs/types';

function makeRoute(overrides: Partial<Route>): Route {
  return { id: 'r-x', shortName: 'X', color: '#000', ...overrides };
}

function makeStation(overrides: Partial<StopWithDistance>): StopWithDistance {
  return { id: 's-x', name: 'X', ...overrides };
}

describe('parseFavoritesTab', () => {
  it('accepts routes', () => {
    expect(parseFavoritesTab('routes')).toBe('routes');
  });
  it('accepts stations', () => {
    expect(parseFavoritesTab('stations')).toBe('stations');
  });
  it('returns null for unknown values', () => {
    expect(parseFavoritesTab('foo')).toBeNull();
    expect(parseFavoritesTab(null)).toBeNull();
    expect(parseFavoritesTab(undefined)).toBeNull();
    expect(parseFavoritesTab('')).toBeNull();
  });
});

describe('stationsPassingFilter', () => {
  const stations = [
    makeStation({ id: 's1', name: 'A' }),
    makeStation({ id: 's2', name: 'B' }),
    makeStation({ id: 's3', name: 'C' }),
  ];

  it('passes every station when no filter is active', () => {
    const out = stationsPassingFilter({
      candidates: stations,
      routesThroughStation: {},
      modeFilter: null,
      networkFilter: null,
    });
    expect(out).toEqual(new Set(['s1', 's2', 's3']));
  });

  it('passes stations with at least one matching route', () => {
    const out = stationsPassingFilter({
      candidates: stations,
      routesThroughStation: {
        s1: [makeRoute({ id: 'r1', type: 'bus' })],
        s2: [makeRoute({ id: 'r2', type: 'metro' })],
        s3: [makeRoute({ id: 'r3', type: 'bus' }), makeRoute({ id: 'r4', type: 'tram' })],
      },
      modeFilter: 'bus',
      networkFilter: null,
    });
    expect(out).toEqual(new Set(['s1', 's3']));
  });

  it('requires the network filter to match', () => {
    const out = stationsPassingFilter({
      candidates: stations,
      routesThroughStation: {
        s1: [makeRoute({ id: 'r1', type: 'bus', networks: ['night'] })],
        s2: [makeRoute({ id: 'r2', type: 'bus', networks: ['school'] })],
      },
      modeFilter: 'bus',
      networkFilter: 'night',
    });
    expect(out).toEqual(new Set(['s1']));
  });

  it('drops stations with no routes-through-station entry', () => {
    const out = stationsPassingFilter({
      candidates: stations,
      routesThroughStation: {
        s1: [makeRoute({ id: 'r1', type: 'bus' })],
      },
      modeFilter: 'bus',
      networkFilter: null,
    });
    expect([...out].sort()).toEqual(['s1']);
  });

  it('combines mode AND network filters', () => {
    const out = stationsPassingFilter({
      candidates: stations,
      routesThroughStation: {
        s1: [makeRoute({ id: 'r1', type: 'bus', networks: ['school'] })],
        s2: [makeRoute({ id: 'r2', type: 'metro', networks: ['school'] })],
        s3: [makeRoute({ id: 'r3', type: 'bus', networks: ['night'] })],
      },
      modeFilter: 'bus',
      networkFilter: 'school',
    });
    expect(out).toEqual(new Set(['s1']));
  });
});

describe('sortRoutesForPicker', () => {
  it('puts active first, alphabetical within tier', () => {
    const routes = [
      makeRoute({ id: 'b', shortName: '2' }),
      makeRoute({ id: 'a', shortName: '1' }),
      makeRoute({ id: 'c', shortName: '3' }),
    ];
    const out = sortRoutesForPicker(routes, new Set(['a']));
    expect(out.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('does not mutate input', () => {
    const routes = [
      makeRoute({ id: 'b', shortName: 'B' }),
      makeRoute({ id: 'a', shortName: 'A' }),
    ];
    sortRoutesForPicker(routes, new Set(['a']));
    expect(routes.map((r) => r.id)).toEqual(['b', 'a']);
  });
});

describe('sortStationsForPicker', () => {
  it('sorts alphabetically when no anchor', () => {
    const stations = [
      makeStation({ id: 'c', name: 'Charlie' }),
      makeStation({ id: 'a', name: 'Alpha' }),
    ];
    const out = sortStationsForPicker(stations);
    expect(out.map((s) => s.id)).toEqual(['a', 'c']);
  });

  it('sorts by distance when anchor is set, prefers precomputed distance', () => {
    const stations = [
      makeStation({ id: 'far', name: 'Far', distance: 5000 }),
      makeStation({ id: 'near', name: 'Near', distance: 100 }),
      makeStation({ id: 'no-coords', name: 'NoCoords' }),
    ];
    const anchor = { lat: 0, lon: 0 };
    const out = sortStationsForPicker(stations, anchor);
    expect(out.map((s) => s.id)).toEqual(['near', 'far', 'no-coords']);
  });

  it('falls back to haversine when distance is missing', () => {
    const stations = [
      makeStation({ id: 'far', name: 'Far', lat: 10, lon: 10 }),
      makeStation({ id: 'near', name: 'Near', lat: 0.001, lon: 0.001 }),
    ];
    const out = sortStationsForPicker(stations, { lat: 0, lon: 0 });
    expect(out.map((s) => s.id)).toEqual(['near', 'far']);
  });
});