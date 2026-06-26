import { describe, expect, it } from 'vitest';
import {
  assembleStationBoard,
  capStationBoard,
  STATION_BOARD_MAX_ROWS,
} from './stationBoard';
import type { BoardRow } from './stationBoard';
import type { Route, Vehicle } from './types';

const r24: Route = { id: 24, shortName: '24', color: '#ff0000' };
const r35: Route = { id: 35, shortName: '35', color: '#00ff00' };
const r9: Route = { id: 9, shortName: '9', color: '#0000ff' };

function scheduled(tripId: string, route: Route, etaMinutes: number): Vehicle {
  return {
    kind: 'scheduled',
    id: `trip:${tripId}`,
    route,
    type: 'bus',
    confidence: 'low',
    schedule: { tripId, scheduledDeparture: 540 + etaMinutes },
    eta: { distanceMeters: 0, minutes: etaMinutes, confidence: 'low' },
  } as Vehicle;
}

const allowAll = {
  showDepartedVehicles: true,
  showDropOffOnly: true,
  showOffRouteVehicles: false,
};

const nowMs = new Date(2026, 5, 26, 9, 0, 0).getTime(); // 09:00 local

describe('assembleStationBoard', () => {
  it('caps at 5 rows with 1 per bucket, expanding incoming to fill', () => {
    const vehicles = [
      scheduled('a', r24, 3),
      scheduled('b', r24, 6),
      scheduled('c', r35, 4),
      scheduled('d', r35, 8),
      scheduled('e', r24, 12),
      scheduled('f', r9, 20),
      scheduled('g', r9, -2), // departed
    ];
    const board = assembleStationBoard(vehicles, allowAll, nowMs);
    expect(board).toHaveLength(5);
    const buckets = board.map((r) => r.bucket);
    expect(buckets.filter((b) => b === 'incoming')).toHaveLength(4);
    expect(buckets.filter((b) => b === 'departed')).toHaveLength(1);
    // Incoming sorted by eta ASC, then departed.
    expect(board.slice(0, 4).map((r) => r.vehicle.schedule?.tripId)).toEqual([
      'a', 'c', 'b', 'd',
    ]);
    expect(board[4].vehicle.schedule?.tripId).toBe('g');
  });

  it('keeps 1 of each represented bucket then fills with incoming', () => {
    // 1 at-station (mid-dwell) + 1 arriving + many incoming.
    const vehicles: Vehicle[] = [
      scheduled('arr', r24, 1),
      {
        kind: 'scheduled',
        id: 'trip:atst',
        route: r35,
        type: 'bus',
        confidence: 'low',
        schedule: { tripId: 'atst', scheduledArrival: 538, scheduledDeparture: 542 },
        eta: { distanceMeters: 0, minutes: 0, confidence: 'low' },
      } as Vehicle,
      scheduled('i1', r24, 4),
      scheduled('i2', r24, 6),
      scheduled('i3', r24, 8),
      scheduled('i4', r24, 10),
    ];
    const board = assembleStationBoard(vehicles, allowAll, nowMs);
    expect(board).toHaveLength(5);
    expect(board.map((r) => r.bucket)).toEqual([
      'at-station', 'arriving', 'incoming', 'incoming', 'incoming',
    ]);
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
});

describe('capStationBoard', () => {
  it('takes one of each bucket — no expansion needed when all 5 are represented', () => {
    const rows: BoardRow[] = [
      { vehicle: scheduled('dep', r24, 0), bucket: 'departing', etaMinutes: 0 },
      { vehicle: scheduled('at', r35, 0), bucket: 'at-station', etaMinutes: 0 },
      { vehicle: scheduled('arr', r9, 1), bucket: 'arriving', etaMinutes: 1 },
      { vehicle: scheduled('i1', r24, 3), bucket: 'incoming', etaMinutes: 3 },
      { vehicle: scheduled('i2', r24, 5), bucket: 'incoming', etaMinutes: 5 },
      { vehicle: scheduled('i3', r35, 8), bucket: 'incoming', etaMinutes: 8 },
      { vehicle: scheduled('d1', r9, -2), bucket: 'departed', etaMinutes: -2 },
    ];
    const out = capStationBoard(rows);
    expect(out).toHaveLength(5);
    // 1 of each bucket; the extra incoming rows drop off.
    expect(out.map((r) => r.bucket)).toEqual([
      'departing', 'at-station', 'arriving', 'incoming', 'departed',
    ]);
  });

  it('fills empty bucket slots with extra incoming up to max', () => {
    // No departing / at-station / arriving / departed. Just incoming.
    // Expansion should fill all 5 slots from the incoming pool.
    const rows: BoardRow[] = Array.from({ length: 8 }, (_, i) => ({
      vehicle: scheduled(`i${i}`, r24, i + 1),
      bucket: 'incoming' as const,
      etaMinutes: i + 1,
    }));
    const out = capStationBoard(rows);
    expect(out).toHaveLength(STATION_BOARD_MAX_ROWS);
    expect(out.every((r) => r.bucket === 'incoming')).toBe(true);
  });

  it("includes 'departed' when there aren't enough incoming to fill", () => {
    const rows: BoardRow[] = [
      { vehicle: scheduled('arr', r24, 1), bucket: 'arriving', etaMinutes: 1 },
      { vehicle: scheduled('i1', r24, 3), bucket: 'incoming', etaMinutes: 3 },
      { vehicle: scheduled('d1', r9, -2), bucket: 'departed', etaMinutes: -2 },
    ];
    const out = capStationBoard(rows);
    expect(out.map((r) => r.bucket)).toEqual(['arriving', 'incoming', 'departed']);
  });

  it("returns fewer than max if there isn't enough data", () => {
    const rows: BoardRow[] = [
      { vehicle: scheduled('i1', r24, 3), bucket: 'incoming', etaMinutes: 3 },
      { vehicle: scheduled('i2', r24, 8), bucket: 'incoming', etaMinutes: 8 },
    ];
    const out = capStationBoard(rows);
    expect(out).toHaveLength(2);
  });

  it('never exceeds STATION_BOARD_MAX_ROWS', () => {
    const rows: BoardRow[] = Array.from({ length: 50 }, (_, i) => ({
      vehicle: scheduled(`i${i}`, r24, i + 1),
      bucket: 'incoming' as const,
      etaMinutes: i + 1,
    }));
    const out = capStationBoard(rows);
    expect(out).toHaveLength(STATION_BOARD_MAX_ROWS);
  });
});
