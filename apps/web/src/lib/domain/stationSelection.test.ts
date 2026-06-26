import { describe, expect, it } from 'vitest';
import { selectBoardsForView } from './stationSelection';
import type { Route, Vehicle } from './types';

const r1: Route = { id: 1, shortName: '1', color: '#000' };
const r2: Route = { id: 2, shortName: '2', color: '#000' };
const r99: Route = { id: 99, shortName: '99', color: '#000' };

const cfg = {
  nearbyRadiusM: 500,
  pairProximityM: 100,
  favoriteFallbackRadiusM: 2000,
};

function stop(id: number, distance: number) {
  return { id, distance };
}
function vehicle(route: Route): Vehicle {
  return {
    kind: 'scheduled',
    id: `v-${route.id}`,
    route,
    type: 'bus',
    confidence: 'low',
    schedule: { tripId: 't', scheduledDeparture: 0 },
  } as Vehicle;
}

describe('selectBoardsForView', () => {
  it('returns the single closest when 2nd is farther than pairProximityM', () => {
    const res = selectBoardsForView({
      candidates: [
        { stop: stop(1, 80), vehicles: [vehicle(r1)] },
        { stop: stop(2, 250), vehicles: [vehicle(r2)] },
      ],
      config: cfg,
      favoriteRouteIds: null,
    });
    expect(res.boards.map((b) => b.stop.id)).toEqual([1]);
    expect(res.expandedStopId).toBe(1);
  });

  it('pairs the 2nd closest when within pairProximityM of the closest', () => {
    const res = selectBoardsForView({
      candidates: [
        { stop: stop(1, 80), vehicles: [vehicle(r1)] },
        { stop: stop(2, 150), vehicles: [vehicle(r2)] }, // delta 70 ≤ 100
        { stop: stop(3, 300), vehicles: [vehicle(r1)] },
      ],
      config: cfg,
      favoriteRouteIds: null,
    });
    expect(res.boards.map((b) => b.stop.id)).toEqual([1, 2]);
    expect(res.expandedStopId).toBe(1); // closest always expanded
  });

  it('never returns a 2nd stop that exceeds nearbyRadiusM, even if close to the closest', () => {
    // Closest is right at the edge of nearbyRadiusM, so the "2nd" is
    // outside it entirely — must be filtered out before the pair check.
    const res = selectBoardsForView({
      candidates: [
        { stop: stop(1, 480), vehicles: [vehicle(r1)] },
        { stop: stop(2, 540), vehicles: [vehicle(r2)] }, // > 500
      ],
      config: cfg,
      favoriteRouteIds: null,
    });
    expect(res.boards.map((b) => b.stop.id)).toEqual([1]);
  });

  it('falls back to closest stop with a favorite route when nothing within nearbyRadiusM', () => {
    const res = selectBoardsForView({
      candidates: [
        { stop: stop(1, 800), vehicles: [vehicle(r2)] },   // no favorite
        { stop: stop(2, 1200), vehicles: [vehicle(r99)] }, // favorite!
        { stop: stop(3, 1500), vehicles: [vehicle(r99)] }, // also favorite, but farther
      ],
      config: cfg,
      favoriteRouteIds: new Set([99]),
    });
    expect(res.boards.map((b) => b.stop.id)).toEqual([2]);
    expect(res.expandedStopId).toBe(2);
  });

  it('favorite fallback respects favoriteFallbackRadiusM', () => {
    const res = selectBoardsForView({
      candidates: [
        { stop: stop(1, 800), vehicles: [vehicle(r2)] },
        { stop: stop(2, 2500), vehicles: [vehicle(r99)] }, // > 2000
      ],
      config: cfg,
      favoriteRouteIds: new Set([99]),
    });
    expect(res.boards).toEqual([]);
    expect(res.expandedStopId).toBeNull();
  });

  it('returns empty when no nearby stops and no favorite set provided', () => {
    const res = selectBoardsForView({
      candidates: [{ stop: stop(1, 800), vehicles: [vehicle(r1)] }],
      config: cfg,
      favoriteRouteIds: null,
    });
    expect(res.boards).toEqual([]);
    expect(res.expandedStopId).toBeNull();
  });

  it('returns empty when candidates is empty', () => {
    const res = selectBoardsForView({
      candidates: [],
      config: cfg,
      favoriteRouteIds: new Set([99]),
    });
    expect(res.boards).toEqual([]);
    expect(res.expandedStopId).toBeNull();
  });
});
