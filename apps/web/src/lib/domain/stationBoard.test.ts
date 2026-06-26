import { describe, expect, it } from 'vitest';
import { assembleStationBoard, collapseDepartedByRoute, dedupRoutes } from './stationBoard';
import type { BoardRow } from './stationBoard';
import type { Route, Vehicle } from './types';

const r24: Route = { id: 24, shortName: '24', color: '#ff0000' };
const r35: Route = { id: 35, shortName: '35', color: '#00ff00' };
const r9: Route = { id: 9, shortName: '9', color: '#0000ff' };
const rM5: Route = { id: 100, shortName: 'M5', color: '#000000' };

function scheduled(tripId: string, route: Route, etaMinutes: number, opts: Partial<Vehicle> = {}): Vehicle {
  return {
    kind: 'scheduled',
    id: `trip:${tripId}`,
    route,
    type: 'bus',
    confidence: 'low',
    schedule: { tripId, scheduledDeparture: 540 + etaMinutes },
    eta: { distanceMeters: 0, minutes: etaMinutes, confidence: 'low' },
    ...opts,
  } as Vehicle;
}

const allowAll = {
  showDepartedVehicles: true,
  showDropOffOnly: true,
};

const nowMs = new Date(2026, 5, 26, 9, 0, 0).getTime(); // 09:00 local

describe('assembleStationBoard', () => {
  it('buckets + filters + sorts in one call', () => {
    const vehicles = [
      scheduled('a', r24, 10), // incoming
      scheduled('b', r35, 1),  // arriving
      scheduled('c', r9, -3),  // departed
      scheduled('d', r24, 3),  // incoming
    ];
    const board = assembleStationBoard(vehicles, allowAll, nowMs);
    // Order: arriving (b) → incoming sorted by eta (d=3, a=10) → departed (c)
    expect(board.map((r) => r.vehicle.schedule?.tripId)).toEqual(['b', 'd', 'a', 'c']);
  });

  it('respects showDepartedVehicles=false', () => {
    const vehicles = [scheduled('a', r24, 10), scheduled('c', r9, -3)];
    const board = assembleStationBoard(
      vehicles,
      { ...allowAll, showDepartedVehicles: false },
      nowMs,
    );
    expect(board).toHaveLength(1);
    expect(board[0].bucket).toBe('incoming');
  });

  it('returns the expected bucket for an arriving vehicle', () => {
    const board = assembleStationBoard([scheduled('a', r24, 1)], allowAll, nowMs);
    expect(board[0].bucket).toBe('arriving');
  });

  it('collapses departed bucket to the most-recent row per route', () => {
    // Two departed runs of route 24 (-1 and -8 min) + one of route 35 (-3).
    // After assembly we expect only the most recent of each route.
    const vehicles = [
      scheduled('a', r24, -1),
      scheduled('b', r24, -8),
      scheduled('c', r35, -3),
    ];
    const board = assembleStationBoard(vehicles, allowAll, nowMs);
    const departed = board.filter((r) => r.bucket === 'departed');
    expect(departed.map((r) => r.vehicle.schedule?.tripId)).toEqual(['a', 'c']);
  });
});

describe('collapseDepartedByRoute', () => {
  it('keeps only the most-recent departed per route, preserves order', () => {
    const rows: BoardRow[] = [
      { vehicle: scheduled('a', r24, -1), bucket: 'departed', etaMinutes: -1 },
      { vehicle: scheduled('b', r24, -8), bucket: 'departed', etaMinutes: -8 },
      { vehicle: scheduled('c', r35, -3), bucket: 'departed', etaMinutes: -3 },
      { vehicle: scheduled('d', r35, -15), bucket: 'departed', etaMinutes: -15 },
    ];
    const out = collapseDepartedByRoute(rows);
    expect(out.map((r) => r.vehicle.schedule?.tripId)).toEqual(['a', 'c']);
  });

  it('passes through non-departed buckets untouched', () => {
    const rows: BoardRow[] = [
      { vehicle: scheduled('a', r24, 3), bucket: 'incoming', etaMinutes: 3 },
      { vehicle: scheduled('b', r24, 5), bucket: 'incoming', etaMinutes: 5 },
      { vehicle: scheduled('c', r24, -1), bucket: 'departed', etaMinutes: -1 },
      { vehicle: scheduled('d', r24, -3), bucket: 'departed', etaMinutes: -3 },
    ];
    const out = collapseDepartedByRoute(rows);
    expect(out.map((r) => `${r.bucket}:${r.vehicle.schedule?.tripId}`)).toEqual([
      'incoming:a',
      'incoming:b',
      'departed:c',
    ]);
  });
});

describe('dedupRoutes', () => {
  it('deduplicates by route id', () => {
    const vehicles = [scheduled('a', r24, 5), scheduled('b', r24, 8), scheduled('c', r35, 3)];
    expect(dedupRoutes(vehicles).map((r) => r.id)).toEqual([24, 35]);
  });

  it('sorts numeric short names numerically, alpha after', () => {
    const vehicles = [
      scheduled('a', rM5, 5),  // 'M5'
      scheduled('b', r24, 5),  // '24'
      scheduled('c', r9, 5),   // '9'
    ];
    expect(dedupRoutes(vehicles).map((r) => r.shortName)).toEqual(['9', '24', 'M5']);
  });
});
