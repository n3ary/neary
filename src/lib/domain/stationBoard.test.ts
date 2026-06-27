import { describe, expect, it } from 'vitest';
import {
  applyGpsEta,
  assembleStationBoard,
  capStationBoard,
  STATION_BOARD_MAX_ROWS,
} from './stationBoard';
import type { BoardRow } from './stationBoard';
import type { Route, Vehicle } from './types';

const r24: Route = { id: '24', shortName: '24', color: '#ff0000' };
const r35: Route = { id: '35', shortName: '35', color: '#00ff00' };
const r9: Route = { id: '9', shortName: '9', color: '#0000ff' };

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

// 09:00 UTC. Tests pass 'UTC' as the timezone so minutes-since-midnight
// inside assembleStationBoard come out to exactly 540 — matching the
// `540 + etaMinutes` schedules below. Keeps the system-local clock out
// of the picture entirely.
const nowMs = Date.UTC(2026, 5, 26, 9, 0, 0);

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
    const board = assembleStationBoard(vehicles, { lat: 46.7712, lon: 23.6236 }, allowAll, nowMs, 'UTC');
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
    const board = assembleStationBoard(vehicles, { lat: 46.7712, lon: 23.6236 }, allowAll, nowMs, 'UTC');
    expect(board).toHaveLength(5);
    expect(board.map((r) => r.bucket)).toEqual([
      'at-station', 'arriving', 'incoming', 'incoming', 'incoming',
    ]);
  });

  it('respects showDepartedVehicles=false', () => {
    const vehicles = [scheduled('a', r24, 10), scheduled('c', r9, -3)];
    const board = assembleStationBoard(
      vehicles,
      { lat: 46.7712, lon: 23.6236 },
      { ...allowAll, showDepartedVehicles: false },
      nowMs,
      'UTC',
    );
    expect(board).toHaveLength(1);
    expect(board[0].bucket).toBe('incoming');
  });
});

describe('applyGpsEta', () => {
  // ~1 km east-west polyline; vehicle 1 km away from stop at vertex 1.
  const POLY: Array<{ lat: number; lon: number }> = [
    { lat: 46.770, lon: 23.580 },
    { lat: 46.770, lon: 23.5931 }, // ~1 km east
    { lat: 46.770, lon: 23.6062 }, // ~2 km east
  ];
  const STOP = { lat: 46.770, lon: 23.6062 };
  const reconciled = (opts: { tripId: string; isAtTripStart?: boolean }): Vehicle => ({
    kind: 'reconciled',
    id: `trip:${opts.tripId}`,
    route: r24,
    type: 'bus',
    tripId: opts.tripId,
    directionId: 0,
    confidence: 'medium',
    schedule: {
      tripId: opts.tripId,
      scheduledDeparture: 540,
      directionId: 0,
      tripStartMin: 530,
      isAtTripStart: opts.isAtTripStart ?? false,
    },
    eta: { distanceMeters: 0, minutes: 99, confidence: 'low' }, // sentinel
    position: { lat: 46.770, lon: 23.580, source: 'gps', asOf: 0, speedMs: 5 },
    liveSources: ['gtfs-rt'],
  } as Vehicle);

  it('replaces ETA on reconciled non-origin rows when a shape is available', () => {
    const out = applyGpsEta(
      [reconciled({ tripId: 'T1' })],
      { T1: POLY },
      STOP,
    );
    expect(out[0].kind).toBe('reconciled');
    // 2 km @ 5 m/s = 400 s = ~7 min, rounded
    expect(out[0].eta?.minutes).toBeGreaterThan(5);
    expect(out[0].eta?.minutes).toBeLessThan(10);
    expect(out[0].eta?.confidence).toBe('high');
  });

  it('skips trip-origin rows (schedule wins at origin)', () => {
    const v = reconciled({ tripId: 'T1', isAtTripStart: true });
    const out = applyGpsEta([v], { T1: POLY }, STOP);
    expect(out[0]).toBe(v); // unchanged
  });

  it('skips when no shape is supplied for the trip', () => {
    const v = reconciled({ tripId: 'T1' });
    const out = applyGpsEta([v], {}, STOP);
    expect(out[0]).toBe(v);
  });

  it('skips non-reconciled rows', () => {
    const sched = scheduled('s', r24, 5);
    const out = applyGpsEta([sched], { 's': POLY }, STOP);
    expect(out[0]).toBe(sched);
  });

  it('is a no-op when the stop has no coords', () => {
    const v = reconciled({ tripId: 'T1' });
    const out = applyGpsEta([v], { T1: POLY }, {});
    expect(out[0]).toBe(v);
  });

  // ── kind:'live' orphan ETAs ────────────────────────────────────────

  const orphan = (opts: { tripId: string; directionId?: 0 | 1 }): Vehicle => ({
    kind: 'live',
    id: `live:${opts.tripId}`,
    route: r24,
    type: 'bus',
    tripId: opts.tripId,
    directionId: opts.directionId ?? 0,
    confidence: 'medium',
    position: { lat: 46.770, lon: 23.580, source: 'gps', asOf: 0, speedMs: 5 },
    liveSources: ['gtfs-rt'],
  } as Vehicle);

  it('computes ETA for kind:live orphans using their own trip shape', () => {
    const v = orphan({ tripId: 'orphan-T2' });
    const out = applyGpsEta([v], { 'orphan-T2': POLY }, STOP);
    if (out[0].kind !== 'live') throw new Error('expected kind=live');
    // 2 km @ 5 m/s = 400 s ≈ 7 min
    expect(out[0].eta?.minutes).toBeGreaterThan(5);
    expect(out[0].eta?.minutes).toBeLessThan(10);
  });

  it("falls back to a sibling's (route, dir) shape when the orphan's own trip_id has no shape", () => {
    // Cluj trip-id-drift case: the orphan's own trip_id isn't in
    // shapes (because it's not in static), but a scheduled sibling
    // on the same (route, dir) provides the shape via the by-route-
    // dir lookup.
    const v = orphan({ tripId: 'orphan-no-shape' });
    const out = applyGpsEta(
      [v],
      {},                                            // no per-trip shape
      STOP,
      { [`${r24.id}|0`]: POLY },                     // sibling-shape fallback
    );
    if (out[0].kind !== 'live') throw new Error('expected kind=live');
    expect(out[0].eta?.minutes).toBeGreaterThan(5);
    expect(out[0].eta?.minutes).toBeLessThan(10);
  });

  it('leaves orphan unchanged when neither own nor sibling shape is available', () => {
    const v = orphan({ tripId: 'orphan-no-shape' });
    const out = applyGpsEta([v], {}, STOP);  // no shapes at all
    expect(out[0]).toBe(v);
    expect(out[0].eta).toBeUndefined();
  });

  // ── At-origin re-evaluation for orphans ────────────────────────────
  //
  // The reconciler can seed orphans with a sibling-derived ETA (see
  // reconcile.ts). applyGpsEta should:
  //  - PRESERVE that seed when the bus is detected at origin
  //    (project near shape start AND speed ~0)
  //  - OVERWRITE it with a GPS-derived ETA once the bus is moving
  //    or its projection has advanced past origin.

  const orphanAtOrigin = (opts: { speedMs: number | null; seededEtaMin: number }): Vehicle => ({
    kind: 'live',
    id: 'live:T-parked',
    route: r24,
    type: 'bus',
    tripId: 'T-parked',
    directionId: 0,
    confidence: 'medium',
    eta: { distanceMeters: 0, minutes: opts.seededEtaMin, confidence: 'low' },
    // Position at first vertex of POLY — i.e. shape's origin.
    position: { lat: 46.770, lon: 23.580, source: 'gps', asOf: 0, speedMs: opts.speedMs },
    liveSources: ['gtfs-rt'],
  } as Vehicle);

  it("preserves the reconciler's seed when the orphan is parked at origin (speed=0)", () => {
    const v = orphanAtOrigin({ speedMs: 0, seededEtaMin: 17 });
    const out = applyGpsEta([v], { 'T-parked': POLY }, STOP);
    expect(out[0]).toBe(v);
    expect(out[0].eta?.minutes).toBe(17);  // seed preserved
  });

  it("preserves the seed when speed is unknown but bus is near origin", () => {
    const v = orphanAtOrigin({ speedMs: null, seededEtaMin: 17 });
    const out = applyGpsEta([v], { 'T-parked': POLY }, STOP);
    expect(out[0].eta?.minutes).toBe(17);
  });

  it("OVERWRITES the seed with a GPS-derived ETA once the bus is moving (early departure)", () => {
    // Same position (near origin) but speed = 5 m/s → bus is moving.
    // GPS-derived ETA should win, replacing the 17-min seed.
    const v = orphanAtOrigin({ speedMs: 5, seededEtaMin: 17 });
    const out = applyGpsEta([v], { 'T-parked': POLY }, STOP);
    // 2 km @ 5 m/s ≈ 7 min, clearly different from the 17 seed.
    expect(out[0].eta?.minutes).toBeGreaterThan(5);
    expect(out[0].eta?.minutes).toBeLessThan(10);
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
