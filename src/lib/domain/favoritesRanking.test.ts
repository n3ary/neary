import { describe, expect, it } from 'vitest';
import { routeMatchesFilters } from './favoritesRanking';
import type { Route, VehicleType } from './types';

function makeRoute(overrides: Partial<Route>): Route {
  return {
    id: 'r-x',
    shortName: 'X',
    color: '#000000',
    ...overrides,
  };
}

describe('routeMatchesFilters', () => {
  it('passes when no filters are set', () => {
    const r: Route = makeRoute({ type: 'bus', networks: ['metroline'] });
    expect(routeMatchesFilters(r, undefined, undefined)).toBe(true);
  });

  it('passes when route type is in mode set', () => {
    const r = makeRoute({ type: 'bus' });
    const modes: ReadonlySet<VehicleType> = new Set(['bus', 'tram']);
    expect(routeMatchesFilters(r, modes, undefined)).toBe(true);
  });

  it('fails when route type is not in mode set', () => {
    const r = makeRoute({ type: 'metro' });
    const modes: ReadonlySet<VehicleType> = new Set(['bus']);
    expect(routeMatchesFilters(r, modes, undefined)).toBe(false);
  });

  it('passes when route network is in network set', () => {
    const r = makeRoute({ networks: ['metroline', 'school'] });
    const networks: ReadonlySet<string> = new Set(['school']);
    expect(routeMatchesFilters(r, undefined, networks)).toBe(true);
  });

  it('fails when route network is not in network set', () => {
    const r = makeRoute({ networks: ['metroline'] });
    const networks: ReadonlySet<string> = new Set(['school']);
    expect(routeMatchesFilters(r, undefined, networks)).toBe(false);
  });

  it('passes when route has no networks (legacy) under non-empty network filter', () => {
    const r = makeRoute({ networks: undefined });
    const networks: ReadonlySet<string> = new Set(['school']);
    expect(routeMatchesFilters(r, undefined, networks)).toBe(true);
  });

  it('fails when network filter is empty (no networks match)', () => {
    const r = makeRoute({ networks: ['metroline'] });
    const networks: ReadonlySet<string> = new Set();
    expect(routeMatchesFilters(r, undefined, networks)).toBe(false);
  });

  it('combines mode + network AND', () => {
    const r = makeRoute({ type: 'bus', networks: ['school'] });
    expect(routeMatchesFilters(r, new Set(['bus']), new Set(['school']))).toBe(true);
    expect(routeMatchesFilters(r, new Set(['tram']), new Set(['school']))).toBe(false);
    expect(routeMatchesFilters(r, new Set(['bus']), new Set(['metroline']))).toBe(false);
  });
});