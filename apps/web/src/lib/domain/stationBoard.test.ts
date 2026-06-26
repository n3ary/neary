import { describe, expect, it } from 'vitest';
import { assembleStationBoard, dedupRoutes } from './stationBoard';
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
  showScheduleOnlyVehicles: true,
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

  it('drops schedule-only vehicles when showScheduleOnlyVehicles=false', () => {
    const vehicles = [scheduled('a', r24, 10), scheduled('b', r35, 5)];
    const board = assembleStationBoard(
      vehicles,
      { ...allowAll, showScheduleOnlyVehicles: false },
      nowMs,
    );
    expect(board).toHaveLength(0);
  });

  it('returns the expected bucket for an arriving vehicle', () => {
    const board = assembleStationBoard([scheduled('a', r24, 1)], allowAll, nowMs);
    expect(board[0].bucket).toBe('arriving');
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
