import { describe, expect, it } from 'vitest';
import {
  applyGpsEta,
  assembleStationBoard,
  bucketLiveBoardMemo,
  capStationBoard,
  DEFAULT_CONTEXT_BUCKET_CAP,
  mergeReconciledIntoStationBoard,
} from './stationBoard';
import type { BoardRow } from './stationBoard';
import type { Route, Vehicle } from './types';

const r24: Route = { id: '24', shortName: '24', color: '#ff0000' };
const r35: Route = { id: '35', shortName: '35', color: '#00ff00' };
const r9: Route = { id: '9', shortName: '9', color: '#0000ff' };

function scheduled(tripId: string, route: Route, etaMinutes: number, directionId: 0 | 1 | -1 = 0): Vehicle {
  return {
    kind: 'scheduled',
    id: `trip:${tripId}`,
    route,
    type: 'bus',
    directionId,
    confidence: 'low',
    schedule: { tripId, scheduledDeparture: 540 + etaMinutes, directionId },
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
  it('per-(route, direction) dedup keeps one incoming row per route', () => {
    // Multi-route board: r24 has 3 incoming, r35 has 2, r9 has 1.
    // Post-dedup: 1 per route in incoming + 1 departed = 4 rows.
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
    expect(board).toHaveLength(4);
    const incoming = board.filter((r) => r.bucket === 'incoming');
    expect(incoming.map((r) => r.vehicle.schedule?.tripId)).toEqual(['a', 'c', 'f']);
    expect(board.at(-1)?.vehicle.schedule?.tripId).toBe('g');
  });

  it('single-route board skips dedup (cap still applies)', () => {
    // Same route+direction everywhere: dedup is a no-op (the board
    // already represents the rider's chosen view). 1 at-station +
    // 1 arriving uncapped + 4 incoming capped at the default of 3 = 5 rows.
    const vehicles: Vehicle[] = [
      scheduled('arr', r24, 1),
      {
        kind: 'scheduled',
        id: 'trip:atst',
        route: r24,
        type: 'bus',
        directionId: 0,
        confidence: 'low',
        schedule: { tripId: 'atst', scheduledArrival: 538, scheduledDeparture: 542, directionId: 0 },
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
  const reconciled = (opts: { tripId: string; isFirstStop?: boolean }): Vehicle => ({
    kind: 'tracked',
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
      isFirstStop: opts.isFirstStop ?? false,
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
    expect(out[0].kind).toBe('tracked');
    // 2 km @ 5 m/s = 400 s = ~7 min, rounded
    expect(out[0].eta?.minutes).toBeGreaterThan(5);
    expect(out[0].eta?.minutes).toBeLessThan(10);
    expect(out[0].eta?.confidence).toBe('high');
  });

  it('skips trip-origin rows (schedule wins at origin)', () => {
    const v = reconciled({ tripId: 'T1', isFirstStop: true });
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

  // ── kind:'gps-only' orphan ETAs ────────────────────────────────────────

  const orphan = (opts: { tripId: string; directionId?: 0 | 1 }): Vehicle => ({
    kind: 'gps-only',
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
    if (out[0].kind !== 'gps-only') throw new Error('expected kind=live');
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
    if (out[0].kind !== 'gps-only') throw new Error('expected kind=live');
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
  // The reconciler can seed orphans with a sibling-derived ETA (see
  // reconcile.ts). applyGpsEta should:
  //  - PRESERVE that seed when the bus is detected at origin
  //    (project near shape start AND speed ~0)
  //  - OVERWRITE it with a GPS-derived ETA once the bus is moving
  //    or its projection has advanced past origin.

  const orphanAtOrigin = (opts: { speedMs: number | null; seededEtaMin: number }): Vehicle => ({
    kind: 'gps-only',
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

  // ── Dead-reckoning a stale GPS fix ─────────────────────
  // The map view extrapolates a vehicle's position forward by
  // (now - fix.asOf) * speed; the station view used to ignore the
  // fix age entirely, so a 2-minute-old fix on a fast-moving bus
  // would still anchor the bus at its OLD position even though the
  // map already had it past the stop. Both views now derive their
  // live position from `deadReckonGpsAlongShape`.

  it('dead-reckons a stale GPS fix forward so a passed bus shows negative ETA', () => {
    // ~2 km east-west polyline, stop at the far (east) end.
    // GPS observation: bus reported at vertex 0 (west end, 2 km west
    // of stop), 120 s ago, moving east at 20 m/s.
    // Dead-reckon: 120 s × 20 m/s = 2400 m forward → past the stop
    // (clamped to totalDistM ≈ 2000 m at the eastern end).
    // ETA should be negative (or 0): "bus is at / past the stop".
    const v: Vehicle = {
      kind: 'tracked',
      id: 'trip:T-stale',
      route: r24,
      type: 'bus',
      tripId: 'T-stale',
      directionId: 0,
      confidence: 'medium',
      schedule: {
        tripId: 'T-stale',
        scheduledDeparture: 540,
        directionId: 0,
        tripStartMin: 530,
        isFirstStop: false,
      },
      eta: { distanceMeters: 0, minutes: 99, confidence: 'low' },
      position: {
        lat: 46.770,
        lon: 23.580,
        source: 'gps',
        asOf: 0,
        speedMs: 20,
      },
      liveSources: ['gtfs-rt'],
    } as Vehicle;
    const out = applyGpsEta([v], { 'T-stale': POLY }, STOP, {}, {
      nowMs: 120_000,
      timezone: 'UTC',
    });
    // Without dead-reckoning: 2 km @ 20 m/s = 100 s ≈ 2 min ahead.
    // With dead-reckoning: bus extrapolated to / past stop → ≤ 0 min.
    expect(out[0].eta?.minutes).toBeLessThanOrEqual(0);
    // Position also reflects the dead-reckoning so the downstream
    // bucketer's haversine distance reads "at the stop", not "1 km
    // before". `source` flips to 'predicted-from-gps' to signal the
    // mutation; `asOf` advances to `nowMs`.
    expect(out[0].position?.source).toBe('predicted-from-gps');
    expect(out[0].position?.asOf).toBe(120_000);
    expect(out[0].position?.lon).toBeGreaterThan(23.580);
  });

  it('agrees with the map when a fresh GPS fix has bus mid-route', () => {
    // Fresh fix (asOf = now), no extrapolation needed: result must
    // match the pre-#86 behaviour exactly. Sanity-check that the
    // refactor didn't shift fresh-fix ETAs.
    const v: Vehicle = {
      kind: 'tracked',
      id: 'trip:T-fresh',
      route: r24,
      type: 'bus',
      tripId: 'T-fresh',
      directionId: 0,
      confidence: 'medium',
      schedule: {
        tripId: 'T-fresh',
        scheduledDeparture: 540,
        directionId: 0,
        tripStartMin: 530,
        isFirstStop: false,
      },
      eta: { distanceMeters: 0, minutes: 99, confidence: 'low' },
      position: {
        lat: 46.770,
        lon: 23.580,
        source: 'gps',
        asOf: 1_000,
        speedMs: 5,
      },
      liveSources: ['gtfs-rt'],
    } as Vehicle;
    const out = applyGpsEta([v], { 'T-fresh': POLY }, STOP, {}, {
      nowMs: 1_000,
      timezone: 'UTC',
    });
    // 2 km @ 5 m/s = 400 s ≈ 7 min.
    expect(out[0].eta?.minutes).toBeGreaterThan(5);
    expect(out[0].eta?.minutes).toBeLessThan(10);
  });
});

describe('capStationBoard', () => {
  it('returns empty for an empty input', () => {
    expect(capStationBoard([])).toEqual([]);
  });

  it('now-group is uncapped — every (route, dir) survives in arriving/at-station/departing', () => {
    // 5 different routes, each with one arriving row. All must survive.
    const rows: BoardRow[] = [
      { vehicle: scheduled('a1', r24, 1), bucket: 'arriving', etaMinutes: 1 },
      { vehicle: scheduled('a2', r35, 1), bucket: 'arriving', etaMinutes: 1 },
      { vehicle: scheduled('a3', r9, 2), bucket: 'arriving', etaMinutes: 2 },
      { vehicle: scheduled('d1', r24, 0), bucket: 'departing', etaMinutes: 0 },
      { vehicle: scheduled('s1', r35, 0), bucket: 'at-station', etaMinutes: 0 },
    ];
    const out = capStationBoard(rows, 3);
    expect(out).toHaveLength(5);
  });

  it('per-(route, direction) dedup inside each bucket', () => {
    // r24 has 3 incoming rows; keep only the soonest.
    const rows: BoardRow[] = [
      { vehicle: scheduled('a', r24, 3), bucket: 'incoming', etaMinutes: 3 },
      { vehicle: scheduled('b', r24, 6), bucket: 'incoming', etaMinutes: 6 },
      { vehicle: scheduled('c', r35, 4), bucket: 'incoming', etaMinutes: 4 },
      { vehicle: scheduled('e', r24, 12), bucket: 'incoming', etaMinutes: 12 },
    ];
    const out = capStationBoard(rows, DEFAULT_CONTEXT_BUCKET_CAP);
    expect(out.map((r) => r.vehicle.schedule?.tripId)).toEqual(['a', 'c']);
  });

  it('directionId undefined and -1 collapse to the same dedup key', () => {
    const v1 = scheduled('u', r24, 3, -1);
    const v2 = scheduled('u2', r24, 6, -1);
    // Defensively also test with truly absent directionId.
    const v3 = { ...scheduled('u3', r24, 9), directionId: undefined } as Vehicle;
    const rows: BoardRow[] = [
      { vehicle: v1, bucket: 'incoming', etaMinutes: 3 },
      { vehicle: v2, bucket: 'incoming', etaMinutes: 6 },
      { vehicle: v3, bucket: 'incoming', etaMinutes: 9 },
    ];
    // Multi-key set is forced by adding a row on r35 so dedup activates.
    rows.push({
      vehicle: scheduled('r35', r35, 1),
      bucket: 'incoming',
      etaMinutes: 1,
    });
    const out = capStationBoard(rows, DEFAULT_CONTEXT_BUCKET_CAP);
    // r24 + r35: dedup keeps soonest of r24 (u) and r35 (r35).
    expect(out.map((r) => r.vehicle.schedule?.tripId).sort()).toEqual(['r35', 'u']);
  });

  it('single-route stop with both directions: dedup skipped, both directions visible', () => {
    // Real-world Cluj case: a mid-line stop serves the same route in
    // both directions. The board is still "one route" from the
    // rider's POV, so dedup must NOT collapse the two directions.
    // Pass an explicit maxRows large enough that the cap doesn't
    // confound the dedup-skip assertion.
    const rows: BoardRow[] = [
      { vehicle: scheduled('north-1', r24, 3, 0), bucket: 'incoming', etaMinutes: 3 },
      { vehicle: scheduled('north-2', r24, 8, 0), bucket: 'incoming', etaMinutes: 8 },
      { vehicle: scheduled('south-1', r24, 5, 1), bucket: 'incoming', etaMinutes: 5 },
      { vehicle: scheduled('south-2', r24, 11, 1), bucket: 'incoming', etaMinutes: 11 },
    ];
    const out = capStationBoard(rows, 10);
    // Single route → dedup skipped → all 4 rows visible.
    expect(out).toHaveLength(4);
  });

  it('respects per-context-bucket cap (maxRows = 3)', () => {
    // 5 routes, each one incoming row. With cap 3 only the soonest 3 survive.
    const rows: BoardRow[] = [
      { vehicle: scheduled('a', { id: 'A', shortName: 'A', color: '#fff' }, 3), bucket: 'incoming', etaMinutes: 3 },
      { vehicle: scheduled('b', { id: 'B', shortName: 'B', color: '#fff' }, 5), bucket: 'incoming', etaMinutes: 5 },
      { vehicle: scheduled('c', { id: 'C', shortName: 'C', color: '#fff' }, 7), bucket: 'incoming', etaMinutes: 7 },
      { vehicle: scheduled('d', { id: 'D', shortName: 'D', color: '#fff' }, 9), bucket: 'incoming', etaMinutes: 9 },
      { vehicle: scheduled('e', { id: 'E', shortName: 'E', color: '#fff' }, 11), bucket: 'incoming', etaMinutes: 11 },
    ];
    const out = capStationBoard(rows, 3);
    expect(out).toHaveLength(3);
    expect(out.map((r) => r.vehicle.schedule?.tripId)).toEqual(['a', 'b', 'c']);
  });

  it('single-route board skips dedup — many incoming rows on same route survive up to cap', () => {
    const rows: BoardRow[] = Array.from({ length: 8 }, (_, i) => ({
      vehicle: scheduled(`i${i}`, r24, i + 1),
      bucket: 'incoming' as const,
      etaMinutes: i + 1,
    }));
    const out = capStationBoard(rows, DEFAULT_CONTEXT_BUCKET_CAP);
    // Single (route, dir) cohort → dedup skipped, cap takes top 5.
    expect(out).toHaveLength(DEFAULT_CONTEXT_BUCKET_CAP);
    expect(out.every((r) => r.vehicle.route.id === '24')).toBe(true);
  });

  it('off-route is uncapped', () => {
    // 4 routes with off-route rows. All must survive even when cap is 1.
    const rows: BoardRow[] = [
      { vehicle: scheduled('o1', r24, 5), bucket: 'off-route', etaMinutes: 5 },
      { vehicle: scheduled('o2', r35, 6), bucket: 'off-route', etaMinutes: 6 },
      { vehicle: scheduled('o3', r9, 7), bucket: 'off-route', etaMinutes: 7 },
    ];
    const out = capStationBoard(rows, 1);
    expect(out).toHaveLength(3);
  });

  it('drop-off dedups by (route, direction) like other context buckets', () => {
    // Two drop-off rows on r24 (one live, one scheduled) and one on r35.
    // Dedup keeps the soonest per (route, direction) regardless of kind.
    const live: Vehicle = {
      kind: 'tracked',
      id: 'live-r24',
      route: r24,
      type: 'bus',
      directionId: 0,
      confidence: 'medium',
      schedule: { tripId: 'live-r24', scheduledDeparture: 541, directionId: 0 },
      eta: { distanceMeters: 0, minutes: 1, confidence: 'medium' },
      position: { lat: 0, lon: 0, source: 'gps', asOf: nowMs },
      liveSources: ['gtfs-rt'],
    } as Vehicle;
    const queued = scheduled('queued-r24', r24, 7);
    const otherRoute = scheduled('r35-drop', r35, 3);
    const rows: BoardRow[] = [
      { vehicle: live, bucket: 'drop-off', etaMinutes: 1 },
      { vehicle: queued, bucket: 'drop-off', etaMinutes: 7 },
      { vehicle: otherRoute, bucket: 'drop-off', etaMinutes: 3 },
    ];
    const out = capStationBoard(rows, DEFAULT_CONTEXT_BUCKET_CAP);
    // r24 dedups to the live (sooner) row; r35 keeps its own.
    expect(out.map((r) => r.vehicle.schedule?.tripId)).toEqual(['live-r24', 'r35-drop']);
  });

  it('drop-off filter: single-route board drops `later` trips', () => {
    // Terminus single-route case. 4 trips arriving as drop-off, with the
    // `tripPhase` already assigned by the upstream scanner. The filter
    // simply drops rows whose phase is `later`.
    const live: Vehicle = {
      kind: 'tracked',
      id: 'live-1',
      route: r24,
      type: 'bus',
      directionId: 0,
      confidence: 'medium',
      schedule: { tripId: 'live-1', scheduledDeparture: 552, tripStartMin: 500, directionId: 0 },
      eta: { distanceMeters: 0, minutes: 2, confidence: 'medium' },
      position: { lat: 0, lon: 0, source: 'gps', asOf: nowMs },
      liveSources: ['gtfs-rt'],
    } as Vehicle;
    const running = {
      ...scheduled('running', r24, 15),
      schedule: {
        tripId: 'running',
        scheduledDeparture: 565,
        tripStartMin: 545,
        directionId: 0,
        tripPhase: 'last',
      },
    } as Vehicle;
    const nextToStart = {
      ...scheduled('next-to-start', r24, 25),
      schedule: {
        tripId: 'next-to-start',
        scheduledDeparture: 575,
        tripStartMin: 555,
        directionId: 0,
        tripPhase: 'next',
      },
    } as Vehicle;
    const laterTrip = {
      ...scheduled('later', r24, 35),
      schedule: {
        tripId: 'later',
        scheduledDeparture: 585,
        tripStartMin: 575,
        directionId: 0,
        tripPhase: 'later',
      },
    } as Vehicle;
    const rows: BoardRow[] = [
      { vehicle: live, bucket: 'drop-off', etaMinutes: 2 },
      { vehicle: running, bucket: 'drop-off', etaMinutes: 15 },
      { vehicle: nextToStart, bucket: 'drop-off', etaMinutes: 25 },
      { vehicle: laterTrip, bucket: 'drop-off', etaMinutes: 35 },
    ];
    const out = capStationBoard(rows, 10);
    expect(out.map((r) => r.vehicle.schedule?.tripId)).toEqual(['live-1', 'running', 'next-to-start']);
  });

  it('`later` filter applies to every bucket on a single-route board, not just drop-off', () => {
    // Single-route incoming bucket with one `next` row and one `later`
    // row. The later row should be dropped even when the cap (10) is
    // big enough to keep both — the rule is "single-route = focus on
    // what's NOW", schedule view answers the next-after-next case.
    const nextRow = {
      ...scheduled('inc-next', r24, 8),
      schedule: {
        tripId: 'inc-next',
        scheduledDeparture: 538,
        tripStartMin: 530,
        directionId: 0,
        tripPhase: 'next',
      },
    } as Vehicle;
    const laterRow = {
      ...scheduled('inc-later', r24, 18),
      schedule: {
        tripId: 'inc-later',
        scheduledDeparture: 548,
        tripStartMin: 540,
        directionId: 0,
        tripPhase: 'later',
      },
    } as Vehicle;
    const rows: BoardRow[] = [
      { vehicle: nextRow, bucket: 'incoming', etaMinutes: 8 },
      { vehicle: laterRow, bucket: 'incoming', etaMinutes: 18 },
    ];
    const out = capStationBoard(rows, 10);
    expect(out.map((r) => r.vehicle.schedule?.tripId)).toEqual(['inc-next']);
  });

  it('preserves compareForBoard order in the output', () => {
    // Departing should come first, then at-station, then arriving, etc.
    const rows: BoardRow[] = [
      { vehicle: scheduled('inc', r9, 5), bucket: 'incoming', etaMinutes: 5 },
      { vehicle: scheduled('dep', r24, 0), bucket: 'departing', etaMinutes: 0 },
      { vehicle: scheduled('at', r35, 0), bucket: 'at-station', etaMinutes: 0 },
    ];
    const out = capStationBoard(rows, DEFAULT_CONTEXT_BUCKET_CAP);
    expect(out.map((r) => r.bucket)).toEqual(['departing', 'at-station', 'incoming']);
  });
});

// ---------------------------------------------------------------------------
// mergeReconciledIntoStationBoard — joins per-stop scheduled rows with the
// worker's global reconciled set by tripId, and emits station-relevant
// orphans with a sibling-derived ETA seed.
// ---------------------------------------------------------------------------

describe('mergeReconciledIntoStationBoard', () => {
  function perStopScheduled(
    tripId: string,
    route: Route,
    dir: 0 | 1,
    tripStartMin: number,
    scheduledArrivalAtStop: number,
    headsign?: string,
  ): Vehicle {
    return {
      kind: 'scheduled',
      id: `trip:${tripId}`,
      route,
      type: 'bus',
      tripId,
      directionId: dir,
      headsign,
      confidence: 'low',
      schedule: {
        tripId,
        scheduledDeparture: scheduledArrivalAtStop,
        scheduledArrival: scheduledArrivalAtStop,
        tripStartMin,
        directionId: dir,
        headsign,
      },
    } as Vehicle;
  }

  function reconciledHit(
    tripId: string,
    route: Route,
    dir: 0 | 1,
    lat: number,
    lon: number,
    asOf: number,
  ): Vehicle {
    return {
      kind: 'tracked',
      id: `trip:${tripId}`,
      route,
      type: 'bus',
      tripId,
      directionId: dir,
      confidence: 'medium',
      schedule: { tripId, scheduledDeparture: 0, tripStartMin: 0, directionId: dir },
      position: { lat, lon, source: 'gps', asOf, speedMs: 5 },
      liveSources: ['gtfs-rt'],
    } as Vehicle;
  }

  function liveOrphan(
    obsTripId: string,
    route: Route,
    dir: 0 | 1,
    tripStartMin: number,
    lat: number,
    lon: number,
  ): Vehicle {
    return {
      kind: 'gps-only',
      id: `live:${obsTripId}`,
      route,
      type: 'bus',
      tripId: obsTripId,
      directionId: dir,
      confidence: 'medium',
      schedule: { tripId: obsTripId, scheduledDeparture: tripStartMin, tripStartMin, directionId: dir },
      position: { lat, lon, source: 'gps', asOf: 0, speedMs: 0 },
      liveSources: ['gtfs-rt'],
    } as Vehicle;
  }

  it('promotes a per-stop scheduled row to reconciled when tripId matches', () => {
    const perStop = [perStopScheduled('T1', r24, 0, 500, 540)];
    const reconciled = [reconciledHit('T1', r24, 0, 46.78, 23.59, 12345)];
    const out = mergeReconciledIntoStationBoard({
      perStopVehicles: perStop,
      reconciledVehicles: reconciled,
      nowMin: 540,
    });
    expect(out).toHaveLength(1);
    const v = out[0];
    expect(v.kind).toBe('tracked');
    expect(v.tripId).toBe('T1');
    // Per-stop schedule is preserved (scheduledArrival at this stop).
    expect(v.schedule?.scheduledArrival).toBe(540);
    // GPS position is copied from the worker's reconciled row.
    expect(v.position?.lat).toBe(46.78);
    expect(v.position?.asOf).toBe(12345);
  });

  it('leaves per-stop rows scheduled when no reconciled match', () => {
    const perStop = [perStopScheduled('T1', r24, 0, 500, 540)];
    // Worker reconciled set has a different trip (T2), not T1.
    const reconciled = [reconciledHit('T2', r24, 0, 46.78, 23.59, 12345)];
    const out = mergeReconciledIntoStationBoard({
      perStopVehicles: perStop,
      reconciledVehicles: reconciled,
      nowMin: 540,
    });
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('scheduled');
    expect(out[0].position).toBeUndefined();
  });

  it('emits orphan live rows when (route, dir) matches the per-stop set', () => {
    const perStop = [
      perStopScheduled('T1', r24, 0, 500, 540, 'North'),
      perStopScheduled('T2', r24, 0, 510, 550, 'North'),
    ];
    // Live obs for a different tripId on the same (route, dir).
    const reconciled = [liveOrphan('LIVE-1', r24, 0, 520, 46.79, 23.60)];
    const out = mergeReconciledIntoStationBoard({
      perStopVehicles: perStop,
      reconciledVehicles: reconciled,
      nowMin: 555,
    });
    // 2 promoted (no live match in reconciled though) + 1 orphan.
    expect(out).toHaveLength(3);
    const orphan = out.find((v) => v.kind === 'gps-only');
    expect(orphan?.tripId).toBe('LIVE-1');
    expect(orphan?.headsign).toBe('North'); // copied from sibling rep
    // ETA seed = obsStartMin + travelTime - nowMin
    //         = 520 + (540 - 500) - 555 = 5
    expect(orphan?.eta?.minutes).toBe(5);
  });

  it('drops orphans whose (route, dir) is not on the per-stop board', () => {
    const perStop = [perStopScheduled('T1', r24, 0, 500, 540)];
    // Different route — station doesn't serve it.
    const reconciled = [liveOrphan('LIVE-X', r35, 0, 520, 46.79, 23.60)];
    const out = mergeReconciledIntoStationBoard({
      perStopVehicles: perStop,
      reconciledVehicles: reconciled,
      nowMin: 555,
    });
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('scheduled');
  });

  it('emits origin-relative orphan ETA when station IS the trip origin', () => {
    // When scheduledArrival === tripStartMin (the per-stop row is the
    // trip's origin), travelTime collapses to 0 and the orphan ETA
    // becomes obsStartMin − nowMin — "minutes since/until the live
    // bus's scheduled origin departure".
    const perStop = [
      perStopScheduled('T1', r24, 0, 500, 500, 'North'), // arrival=start=500
    ];
    const reconciled = [liveOrphan('LIVE-1', r24, 0, 520, 46.79, 23.60)];
    const out = mergeReconciledIntoStationBoard({
      perStopVehicles: perStop,
      reconciledVehicles: reconciled,
      nowMin: 555,
    });
    const orphan = out.find((v) => v.kind === 'gps-only');
    expect(orphan).toBeTruthy();
    // 520 + 0 − 555 = -35 (bus's scheduled origin departure was 35 min ago).
    expect(orphan?.eta?.minutes).toBe(-35);
  });

  it('propagates dropOffOnly from per-stop siblings to orphan rows', () => {
    // At a terminus / drop-off-only stop, every per-stop scheduled
    // row has dropOffOnly=true. A live orphan emitted into the same
    // station context must inherit the flag so it routes to the
    // `drop-off` bucket downstream instead of leaking into the now-
    // group buckets.
    const perStop: Vehicle[] = [
      {
        ...perStopScheduled('T1', r24, 0, 500, 540, 'Centru'),
        dropOffOnly: true,
      } as Vehicle,
    ];
    const reconciled = [liveOrphan('LIVE-1', r24, 0, 520, 46.79, 23.60)];
    const out = mergeReconciledIntoStationBoard({
      perStopVehicles: perStop,
      reconciledVehicles: reconciled,
      nowMin: 555,
    });
    const orphan = out.find((v) => v.kind === 'gps-only');
    expect(orphan?.dropOffOnly).toBe(true);
  });
});

describe('bucketLiveBoardMemo', () => {
  const stop = { id: 1, name: 'A', lat: 46.77, lon: 23.62 };
  const vehicles: Vehicle[] = [];
  const prefs = { showDropOffOnly: false, hideScheduleOnly: false, hideDeparted: false } as never;
  const baseInputs = {
    vehicles, stop, prefs,
    nowMs: 1_750_000_000_000, timezone: 'Europe/Bucharest',
  } as const;

  it('returns the same reference on repeated calls with identical inputs', () => {
    const a = bucketLiveBoardMemo(baseInputs);
    const b = bucketLiveBoardMemo(baseInputs);
    expect(b).toBe(a); // cache hit returns the exact same array
  });

  it('returns a different reference when a primitive input changes', () => {
    const a = bucketLiveBoardMemo(baseInputs);
    const b = bucketLiveBoardMemo({ ...baseInputs, nowMs: baseInputs.nowMs + 1 });
    expect(b).not.toBe(a);
  });

  it('returns a different reference when the vehicles array reference changes', () => {
    const a = bucketLiveBoardMemo(baseInputs);
    const b = bucketLiveBoardMemo({ ...baseInputs, vehicles: [...vehicles] });
    expect(b).not.toBe(a);
  });

  it('caches independently per stop reference', () => {
    const stopA = { ...stop, id: 1 };
    const stopB = { ...stop, id: 2 };
    const a1 = bucketLiveBoardMemo({ ...baseInputs, stop: stopA });
    const b1 = bucketLiveBoardMemo({ ...baseInputs, stop: stopB });
    // Different stops, different cache slots — each one returns its own
    // reference, and a re-call still hits the per-stop cache.
    const a2 = bucketLiveBoardMemo({ ...baseInputs, stop: stopA });
    const b2 = bucketLiveBoardMemo({ ...baseInputs, stop: stopB });
    expect(a2).toBe(a1);
    expect(b2).toBe(b1);
    expect(a1).not.toBe(b1);
  });
});
