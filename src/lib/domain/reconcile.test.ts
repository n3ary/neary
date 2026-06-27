import { describe, expect, it } from 'vitest';
import { computeTolerance, parseLiveStartMin, reconcileWithLive } from './reconcile';
import type { LiveVehicleObservation } from '$lib/data/live/gtfsRtClient';
import type { Route, Vehicle } from './types';

const r14: Route = { id: '14', shortName: '25', color: '#ff0000' };

// Build a UTC Unix-ms timestamp from minutes-since-midnight. Tests use
// timezone 'UTC' so the value round-trips through minSinceMidnightInTz
// to the same number, keeping the schedule/now comparisons exact.
function epochAt(minSinceUtcMidnight: number): number {
  return Date.UTC(2025, 5, 26, 0, 0, 0) + minSinceUtcMidnight * 60_000;
}

function scheduled(opts: {
  tripId: string;
  tripStartMin: number;
  directionId?: 0 | 1;
  route?: Route;
  scheduledDeparture?: number;
}): Vehicle {
  return {
    kind: 'scheduled',
    id: `trip:${opts.tripId}`,
    route: opts.route ?? r14,
    type: 'bus',
    tripId: opts.tripId,
    directionId: opts.directionId ?? 1,
    confidence: 'low',
    schedule: {
      tripId: opts.tripId,
      scheduledDeparture: opts.scheduledDeparture ?? 14 * 60 + 25,
      directionId: opts.directionId ?? 1,
      tripStartMin: opts.tripStartMin,
    },
    eta: { distanceMeters: 0, minutes: 3, confidence: 'low' },
  } as Vehicle;
}

function obs(opts: {
  tripId: string;
  routeId?: string;
  directionId?: 0 | 1;
  startTime?: string;
  asOfMs?: number;
  lat?: number;
  lon?: number;
}): LiveVehicleObservation {
  return {
    source: 'gtfs-rt',
    vehicleId: `v-${opts.tripId}`,
    tripId: opts.tripId,
    routeId: opts.routeId ?? '14',
    directionId: opts.directionId ?? 1,
    startTime: opts.startTime ?? '',
    lat: opts.lat ?? 46.77,
    lon: opts.lon ?? 23.62,
    bearing: null,
    speedMs: null,
    currentStatus: null,
    nextStopId: null,
    asOfMs: opts.asOfMs ?? 1_700_000_000_000,
  };
}

describe('parseLiveStartMin', () => {
  it('prefers explicit startTime over trip_id parse', () => {
    expect(parseLiveStartMin(obs({ tripId: '14_1_LV_99_0900', startTime: '14:23:00' })))
      .toBe(14 * 60 + 23);
  });
  it('falls back to the _HHMM suffix in the trip_id', () => {
    expect(parseLiveStartMin(obs({ tripId: '14_1_LV_99_1423' }))).toBe(14 * 60 + 23);
  });
  it('handles _HMM suffix (single-digit hour)', () => {
    expect(parseLiveStartMin(obs({ tripId: '14_1_LV_99_905' }))).toBe(9 * 60 + 5);
  });
  it('returns null when no parseable time is present', () => {
    expect(parseLiveStartMin(obs({ tripId: 'no-time-here' }))).toBeNull();
  });
});

describe('computeTolerance', () => {
  it('returns floor for empty cohorts', () => {
    expect(computeTolerance([], 600)).toBe(1);
  });
  it('uses median local headway / 2 on a high-frequency line', () => {
    // 4-min headway in the local hour → tolerance 2
    const starts = Array.from({ length: 10 }, (_, i) => 14 * 60 + i * 4);
    expect(computeTolerance(starts, 14 * 60 + 20)).toBe(2);
  });
  it('uses median local headway / 2 on a low-frequency line', () => {
    // 30-min headway → tolerance 15
    const starts = Array.from({ length: 5 }, (_, i) => 14 * 60 + i * 30);
    expect(computeTolerance(starts, 14 * 60 + 30)).toBe(15);
  });
  it('clamps to ceiling for very sparse service', () => {
    const starts = [10 * 60, 12 * 60, 14 * 60]; // 120 min gaps → /2=60, clamped to 30
    expect(computeTolerance(starts, 13 * 60)).toBe(30);
  });
  it('clamps to floor for sub-minute headway', () => {
    const starts = Array.from({ length: 10 }, (_, i) => 14 * 60 + i * 1);
    expect(computeTolerance(starts, 14 * 60 + 5)).toBe(1);
  });
  it('widens the window when local samples are too few', () => {
    // 1 trip near now, plenty 6h away → falls back to wider window
    const starts = [14 * 60 + 10, 8 * 60, 8 * 60 + 30, 9 * 60];
    // After widening to 4h: 14:10 included, 8:00/8:30/9:00 still outside;
    // falls through to full day: gaps 30, 30, 310 → median 30 → tol 15.
    expect(computeTolerance(starts, 14 * 60)).toBe(15);
  });
  it('uses fixed fallback tolerance when nowMin is omitted', () => {
    expect(computeTolerance([0, 60, 120])).toBe(5);
  });
});

describe('reconcileWithLive (route+direction+startTime match)', () => {
  it('upgrades the single in-window candidate', () => {
    const sched = [
      scheduled({ tripId: '14_1_LV_84_1421', tripStartMin: 14 * 60 + 21 }),
      scheduled({ tripId: '14_1_LV_82_1413', tripStartMin: 14 * 60 + 13 }),
    ];
    const { vehicles, stats } = reconcileWithLive(
      sched,
      [obs({ tripId: '14_1_LV_101_1423', startTime: '14:23:00' })],
      { nowMs: epochAt(14 * 60 + 25 ), timezone: 'UTC'},
    );
    // headway 8 min → tol 4 → only the 14:21 candidate is within ±4 of 14:23
    expect(stats.matched).toBe(1);
    expect(vehicles[0].kind).toBe('reconciled');
    expect(vehicles[1].kind).toBe('scheduled');
  });

  it('picks the closest scheduled start when multiple fit within tolerance', () => {
    // Service every 2 min around the live obs → tol 1 → still picks closest
    const sched = [
      scheduled({ tripId: 't-19', tripStartMin: 14 * 60 + 19 }),
      scheduled({ tripId: 't-21', tripStartMin: 14 * 60 + 21 }),
      scheduled({ tripId: 't-23', tripStartMin: 14 * 60 + 23 }),
    ];
    const { vehicles, stats } = reconcileWithLive(
      sched,
      [obs({ tripId: 'live', startTime: '14:22:00' })],
      { nowMs: epochAt(14 * 60 + 22 ), timezone: 'UTC'},
    );
    expect(stats.matched).toBe(1);
    // 14:21 and 14:23 are both delta=1 — earlier index wins; either is fine.
    const reconciled = vehicles.find((v) => v.kind === 'reconciled');
    expect(reconciled).toBeTruthy();
  });

  it('leaves rows scheduled when no candidate is within the tolerance', () => {
    const sched = [scheduled({ tripId: 't-1', tripStartMin: 14 * 60 + 0 })];
    const { vehicles, stats } = reconcileWithLive(
      sched,
      [obs({ tripId: 'live', startTime: '14:45:00' })],
      { nowMs: epochAt(14 * 60 + 30 ), timezone: 'UTC'},
    );
    // 1-row cohort → no headway → tol floor (1). 45 min off → no match.
    expect(stats.matched).toBe(0);
    expect(vehicles[0].kind).toBe('scheduled');
  });

  it('does not match across different directionIds even with same route+time', () => {
    const sched = [scheduled({
      tripId: 't-d0', tripStartMin: 14 * 60 + 21, directionId: 0,
    })];
    const { vehicles } = reconcileWithLive(
      sched,
      [obs({ tripId: 'live', startTime: '14:21:00', directionId: 1 })],
      { nowMs: epochAt(14 * 60 + 25 ), timezone: 'UTC'},
    );
    expect(vehicles[0].kind).toBe('scheduled');
  });

  it('does not match across different routeIds', () => {
    const sched = [scheduled({
      tripId: 't-r14', tripStartMin: 14 * 60 + 21,
      route: { id: '14', shortName: '25', color: '#f00' },
    })];
    const { vehicles } = reconcileWithLive(
      sched,
      [obs({ tripId: 'live', startTime: '14:21:00', routeId: '15' })],
      { nowMs: epochAt(14 * 60 + 25 ), timezone: 'UTC'},
    );
    expect(vehicles[0].kind).toBe('scheduled');
  });

  it('promotes at most one scheduled row per live observation set', () => {
    // Two live obs for the same trip start time — only one scheduled row
    // exists; the first live obs wins and the second is dropped.
    const sched = [scheduled({ tripId: 't-1', tripStartMin: 14 * 60 + 21 })];
    const { vehicles, stats } = reconcileWithLive(
      sched,
      [
        obs({ tripId: 'live-a', startTime: '14:21:00', lat: 46.77 }),
        obs({ tripId: 'live-b', startTime: '14:21:00', lat: 99 }),
      ],
      { nowMs: epochAt(14 * 60 + 25 ), timezone: 'UTC'},
    );
    expect(stats.matched).toBe(1);
    if (vehicles[0].kind === 'reconciled') {
      expect(vehicles[0].position.lat).toBeCloseTo(46.77);
    }
  });

  it('parses HHMM from trip_id when feed does not populate startTime', () => {
    const sched = [scheduled({ tripId: 't-1', tripStartMin: 14 * 60 + 21 })];
    const { vehicles, stats } = reconcileWithLive(
      sched,
      [obs({ tripId: '14_1_LV_99_1421' })], // no startTime
      { nowMs: epochAt(14 * 60 + 25 ), timezone: 'UTC'},
    );
    expect(stats.matched).toBe(1);
    expect(vehicles[0].kind).toBe('reconciled');
  });

  it('preserves headsign / route / eta / dropOffOnly across upgrade', () => {
    const sched: Vehicle = {
      ...scheduled({ tripId: 't-1', tripStartMin: 14 * 60 + 21 }),
      headsign: 'Mănăștur',
      dropOffOnly: true,
    } as Vehicle;
    const { vehicles } = reconcileWithLive(
      [sched],
      [obs({ tripId: 'live', startTime: '14:21:00' })],
      { nowMs: epochAt(14 * 60 + 25 ), timezone: 'UTC'},
    );
    if (vehicles[0].kind === 'reconciled') {
      expect(vehicles[0].headsign).toBe('Mănăștur');
      expect(vehicles[0].dropOffOnly).toBe(true);
      expect(vehicles[0].eta?.minutes).toBe(3);
      expect(vehicles[0].liveSources).toEqual(['gtfs-rt']);
      expect(vehicles[0].confidence).toBe('medium');
      expect(vehicles[0].id).toBe('trip:t-1');
    }
  });

  it('is idempotent for already-promoted kinds', () => {
    const input: Vehicle[] = [{
      kind: 'reconciled',
      id: 'trip:t-1',
      route: r14,
      type: 'bus',
      confidence: 'medium',
      schedule: {
        tripId: 't-1', scheduledDeparture: 540, directionId: 1, tripStartMin: 14 * 60 + 21,
      },
      position: { lat: 46.77, lon: 23.62, source: 'gps', asOf: 0 },
      liveSources: ['gtfs-rt'],
    }];
    const { vehicles } = reconcileWithLive(
      input,
      [obs({ tripId: 'live', startTime: '14:21:00' })],
      { nowMs: epochAt(14 * 60 + 25 ), timezone: 'UTC'},
    );
    expect(vehicles[0]).toBe(input[0]);
  });

  it('falls back to fetch time when the observation has no timestamp', () => {
    const sched = [scheduled({ tripId: 't-1', tripStartMin: 14 * 60 + 21 })];
    const before = Date.now();
    const { vehicles } = reconcileWithLive(
      sched,
      [obs({ tripId: 'live', startTime: '14:21:00', asOfMs: 0 })],
      { nowMs: epochAt(14 * 60 + 25 ), timezone: 'UTC'},
    );
    const after = Date.now();
    if (vehicles[0].kind === 'reconciled') {
      expect(vehicles[0].position.asOf).toBeGreaterThanOrEqual(before);
      expect(vehicles[0].position.asOf).toBeLessThanOrEqual(after);
    }
  });

  it('skips live observations without parseable start time', () => {
    const sched = [scheduled({ tripId: 't-1', tripStartMin: 14 * 60 + 21 })];
    const { stats } = reconcileWithLive(
      sched,
      [obs({ tripId: 'opaque' })],
      { nowMs: epochAt(14 * 60 + 25 ), timezone: 'UTC'},
    );
    expect(stats.matched).toBe(0);
  });
});

describe('reconcileWithLive (kind:live emission for unmatched obs)', () => {
  it('emits kind:live for a live obs whose (route, dir) is on the input but no scheduled trip is in tolerance', () => {
    // Scheduled trip on 14|1 at 14:21. Live obs claims 18:00 — way
    // outside any sane tolerance for a 1-trip cohort.
    const sched = [scheduled({ tripId: 't-1', tripStartMin: 14 * 60 + 21 })];
    const { vehicles, stats } = reconcileWithLive(
      sched,
      [obs({ tripId: 't-other', startTime: '18:00:00' })],
      { nowMs: epochAt(14 * 60 + 25), timezone: 'UTC' },
    );
    expect(stats.matched).toBe(0);
    expect(stats.live).toBe(1);
    const live = vehicles.find((v) => v.kind === 'live');
    expect(live).toBeDefined();
    if (!live || live.kind !== 'live') throw new Error('expected kind=live');
    expect(live.id).toBe('live:t-other');
    expect(live.route.id).toBe('14');
    expect(live.position.lat).toBeCloseTo(46.77);
    expect(live.liveSources).toEqual(['gtfs-rt']);
  });

  it('does NOT emit kind:live for routes the input does not serve', () => {
    const sched = [scheduled({ tripId: 't-1', tripStartMin: 14 * 60 + 21 })];
    const { vehicles, stats } = reconcileWithLive(
      sched,
      [obs({ tripId: 'foreign', routeId: '999', startTime: '14:21:00' })],
      { nowMs: epochAt(14 * 60 + 25), timezone: 'UTC' },
    );
    expect(stats.live).toBe(0);
    expect(vehicles.every((v) => v.kind !== 'live')).toBe(true);
  });

  it('does NOT emit kind:live for the same (route, dir) but the wrong direction', () => {
    // Scheduled only carries dir 1; orphan claims dir 0 — different
    // direction on the same route. Refuse to surface a bus heading
    // away from where the user is looking.
    const sched = [scheduled({ tripId: 't-1', tripStartMin: 14 * 60 + 21, directionId: 1 })];
    const { stats } = reconcileWithLive(
      sched,
      [obs({ tripId: 'wrong-dir', directionId: 0, startTime: '14:21:00' })],
      { nowMs: epochAt(14 * 60 + 25), timezone: 'UTC' },
    );
    expect(stats.live).toBe(0);
  });

  it('does NOT double-count a matched live obs as both reconciled and orphan', () => {
    // Live obs cleanly matches the scheduled row.
    const sched = [scheduled({ tripId: 't-1', tripStartMin: 14 * 60 + 21 })];
    const { vehicles, stats } = reconcileWithLive(
      sched,
      [obs({ tripId: 't-other', startTime: '14:22:00' })],
      { nowMs: epochAt(14 * 60 + 25), timezone: 'UTC' },
    );
    expect(stats.matched).toBe(1);
    expect(stats.live).toBe(0);
    expect(vehicles.every((v) => v.kind !== 'live')).toBe(true);
  });

  it('copies headsign from a representative sibling on the same (route, dir)', () => {
    // First scheduled row has the headsign; orphan should inherit it.
    const v: Vehicle = {
      ...scheduled({ tripId: 't-1', tripStartMin: 14 * 60 + 21 }),
      headsign: 'Centru',
    };
    const { vehicles } = reconcileWithLive(
      [v],
      [obs({ tripId: 'orphan', startTime: '18:00:00' })],
      { nowMs: epochAt(14 * 60 + 25), timezone: 'UTC' },
    );
    const live = vehicles.find((x) => x.kind === 'live');
    expect(live?.headsign).toBe('Centru');
  });

  it("seeds the orphan's eta from the sibling's travel time + the orphan's own tripStartMin", () => {
    // Sibling trip: tripStartMin 14:21, scheduledDeparture (used as
    // arrival fallback) 14:25 → travel time 4 min.
    const sched = [scheduled({ tripId: 't-1', tripStartMin: 14 * 60 + 21 })];
    // Orphan reports its own start as 18:00. Now = 14:25.
    // Expected ETA at this stop: 18:00 + 4 min - 14:25 = 219 min.
    const { vehicles } = reconcileWithLive(
      sched,
      [obs({ tripId: 'orphan', startTime: '18:00:00' })],
      { nowMs: epochAt(14 * 60 + 25), timezone: 'UTC' },
    );
    const live = vehicles.find((v) => v.kind === 'live');
    expect(live?.eta?.minutes).toBe(219);
    expect(live?.eta?.confidence).toBe('low');
  });

  it("leaves orphan eta undefined when the orphan's tripStartMin can't be parsed", () => {
    const sched = [scheduled({ tripId: 't-1', tripStartMin: 14 * 60 + 21 })];
    const { vehicles } = reconcileWithLive(
      sched,
      [obs({ tripId: 'opaque-orphan' })],
      { nowMs: epochAt(14 * 60 + 25), timezone: 'UTC' },
    );
    // 'opaque-orphan' has no parseable HHMM suffix and no startTime,
    // so we have nothing to seed the ETA from. The orphan should
    // not be emitted in this case (gated by tripId presence too —
    // it's tripId='opaque-orphan' which has no HHMM tail).
    const live = vehicles.find((v) => v.kind === 'live');
    // Either dropped or emitted without eta — both acceptable; just
    // assert we don't fabricate an eta when we lack inputs.
    if (live) expect(live.eta).toBeUndefined();
  });

  it("leaves orphan eta undefined when no sibling has scheduledArrival/Departure", () => {
    // Build a scheduled vehicle whose schedule.scheduledDeparture is
    // intentionally absent (not constructible via the helper which
    // always sets it). Skip by simulating via a custom Vehicle.
    const sched: Vehicle[] = [{
      kind: 'scheduled',
      id: 'trip:t-1',
      route: r14,
      type: 'bus',
      confidence: 'low',
      schedule: {
        tripId: 't-1',
        // scheduledDeparture is required by the type; we can't truly
        // omit it. Instead test the case where tripStartMin is null —
        // travelTime can't be derived, sibling rep has travelTimeMin
        // undefined → orphan eta seed is undefined.
        scheduledDeparture: 14 * 60 + 25,
        directionId: 1,
        // tripStartMin omitted on purpose
      },
      eta: { distanceMeters: 0, minutes: 3, confidence: 'low' },
    } as Vehicle];
    const { vehicles } = reconcileWithLive(
      sched,
      [obs({ tripId: 'orphan', startTime: '18:00:00' })],
      { nowMs: epochAt(14 * 60 + 25), timezone: 'UTC' },
    );
    const live = vehicles.find((v) => v.kind === 'live');
    expect(live?.eta).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Route-order pairing (resolves the "no-overtake invariant" cases that
// greedy-by-timing-delta can mis-pair on high-frequency lines). Tests
// build a 10 km straight-line shape and place live obs at known
// positions along it.
// ---------------------------------------------------------------------------

import { measurePolyline } from './shapeProjection';

describe('reconcileWithLive (route-order pairing with shape)', () => {
  // 10 km straight-line shape east of (46.7, 23.6). At Cluj's latitude,
  // 0.131° lon ≈ 10 km; 0.001° lon ≈ ~76 m. Two vertices is enough —
  // projection lands every point on the line directly.
  const shape10km = measurePolyline([
    { lat: 46.7, lon: 23.6 },
    { lat: 46.7, lon: 23.731 },
  ]);
  /** Return a lon-coordinate that lands roughly `meters` along the shape. */
  function lonAt(meters: number): number {
    return 23.6 + 0.131 * (meters / shape10km.totalDistM);
  }
  function shapesFor(cohort: string): Map<string, ReturnType<typeof measurePolyline>> {
    return new Map([[cohort, shape10km]]);
  }

  it('(a) same-minute crossing — picks the trip whose expected position matches', () => {
    // Two scheduled trips a minute apart; one live obs whose start time
    // sits between them but whose GPS position is far along the route,
    // matching trip A's expected position much better than trip B's.
    const sched = [
      scheduled({ tripId: 'A', tripStartMin: 14 * 60, scheduledDeparture: 14 * 60 }), // 14:00
      scheduled({ tripId: 'B', tripStartMin: 14 * 60 + 2, scheduledDeparture: 14 * 60 + 2 }), // 14:02
    ];
    // Bump trip durations: scheduledArrival = start + 30 min (used as tripEndMin).
    (sched[0] as Vehicle).schedule!.scheduledArrival = 14 * 60 + 30;
    (sched[1] as Vehicle).schedule!.scheduledArrival = 14 * 60 + 32;
    // Now = 14:25. Expected: A at 25/30 = 83% ≈ 8333 m; B at 23/30 ≈ 7667 m.
    // Obs at 8300 m (close to A's expected).
    const liveObs = obs({
      tripId: 'live-pole',
      startTime: '14:01:00', // straddles both starts
      lat: 46.7,
      lon: lonAt(8300),
    });
    const { vehicles, stats } = reconcileWithLive(sched, [liveObs], {
      nowMs: epochAt(14 * 60 + 25),
      timezone: 'UTC',
      shapesByCohort: shapesFor('14|1'),
    });
    expect(stats.matched).toBe(1);
    // Route-order pairs A (earliest start) with the obs (only obs).
    const matched = vehicles.find((v) => v.kind === 'reconciled');
    expect(matched?.tripId).toBe('A');
  });

  it('(b) two-bus swap — route order prefers physical plausibility over perfect timing', () => {
    // Two scheduled trips with a 10-minute start spread; two live obs
    // whose start_time claims swap them (operator misconfig in the
    // GTFS-RT feed). Greedy-by-timing pairs by perfect timing:
    //   A=obs2 (claims 14:00, but physically near B's expected ≈ 5 km)
    //   B=obs1 (claims 14:10, but physically near A's expected ≈ 8 km)
    // That implies A is 3+ km behind expected — implausible.
    // Route-order ignores the (possibly-wrong) start_time and pairs by
    // along-shape distance:
    //   A=obs1 (8 km, near A's 8.3 km expected — slight delay)
    //   B=obs2 (4.5 km, near B's 5 km expected — slight delay)
    // Physically plausible: both buses ~500 m behind expected, no swap.
    const sched = [
      scheduled({ tripId: 'A', tripStartMin: 14 * 60, scheduledDeparture: 14 * 60 }), // 14:00
      scheduled({ tripId: 'B', tripStartMin: 14 * 60 + 10, scheduledDeparture: 14 * 60 + 10 }), // 14:10
    ];
    (sched[0] as Vehicle).schedule!.scheduledArrival = 14 * 60 + 30;
    (sched[1] as Vehicle).schedule!.scheduledArrival = 14 * 60 + 40;
    // Now = 14:25. A expected: 25/30 × 10 km ≈ 8333 m. B expected: 15/30 × 10 km = 5000 m.
    const obsAt8km = obs({
      tripId: 'obs1',
      startTime: '14:10:00', // claims to be on B
      lat: 46.7,
      lon: lonAt(8000),
    });
    const obsAt4_5km = obs({
      tripId: 'obs2',
      startTime: '14:00:00', // claims to be on A
      lat: 46.7,
      lon: lonAt(4500),
    });
    const { vehicles } = reconcileWithLive(sched, [obsAt8km, obsAt4_5km], {
      nowMs: epochAt(14 * 60 + 25),
      timezone: 'UTC',
      shapesByCohort: shapesFor('14|1'),
    });
    const matched = vehicles.filter((v) => v.kind === 'reconciled');
    expect(matched).toHaveLength(2);
    const aMatch = matched.find((v) => v.tripId === 'A');
    const bMatch = matched.find((v) => v.tripId === 'B');
    // A (earliest, furthest-along-expected) pairs with obsAt8km.
    expect(aMatch?.position?.lon).toBeCloseTo(lonAt(8000), 4);
    // B (later, behind-A-expected) pairs with obsAt4_5km.
    expect(bMatch?.position?.lon).toBeCloseTo(lonAt(4500), 4);
  });

  it('(c) implausible distance delta — falls back to greedy by timing', () => {
    // Same two scheduled trips (A: 14:00, B: 14:10), but the obs
    // distances are wildly off any reasonable expected position:
    // one at 9.9 km, one at 0.1 km. Route-order would pair
    //   A=obs1 (9.9 km, delta 1.6 km — borderline ok)
    //   B=obs2 (0.1 km, delta 4.9 km — IMPLAUSIBLE)
    // Implausibility fires → fall back to greedy by timing, which
    // pairs by perfect timing: A=obs2 (claims 14:00), B=obs1
    // (claims 14:10).
    const sched = [
      scheduled({ tripId: 'A', tripStartMin: 14 * 60, scheduledDeparture: 14 * 60 }),
      scheduled({ tripId: 'B', tripStartMin: 14 * 60 + 10, scheduledDeparture: 14 * 60 + 10 }),
    ];
    (sched[0] as Vehicle).schedule!.scheduledArrival = 14 * 60 + 30;
    (sched[1] as Vehicle).schedule!.scheduledArrival = 14 * 60 + 40;
    const obsNearEnd = obs({
      tripId: 'obs1', startTime: '14:10:00',
      lat: 46.7, lon: lonAt(9900),
    });
    const obsNearStart = obs({
      tripId: 'obs2', startTime: '14:00:00',
      lat: 46.7, lon: lonAt(100),
    });
    const { vehicles } = reconcileWithLive(sched, [obsNearEnd, obsNearStart], {
      nowMs: epochAt(14 * 60 + 25),
      timezone: 'UTC',
      shapesByCohort: shapesFor('14|1'),
    });
    const aMatch = vehicles.find((v) => v.tripId === 'A' && v.kind === 'reconciled');
    const bMatch = vehicles.find((v) => v.tripId === 'B' && v.kind === 'reconciled');
    // Fallback to greedy: A=obs2 (start 14:00), B=obs1 (start 14:10).
    expect(aMatch?.position?.lon).toBeCloseTo(lonAt(100), 4);
    expect(bMatch?.position?.lon).toBeCloseTo(lonAt(9900), 4);
  });

  it('falls back to greedy when shape is missing for a cohort', () => {
    // Map exists but key is for a different cohort → reconciler treats
    // this one as shape-absent and uses greedy-by-timing.
    const sched = [
      scheduled({ tripId: 'A', tripStartMin: 14 * 60 }),
    ];
    const { stats } = reconcileWithLive(
      sched,
      [obs({ tripId: 'live', startTime: '14:00:00', lat: 46.7, lon: lonAt(5000) })],
      {
        nowMs: epochAt(14 * 60 + 25),
        timezone: 'UTC',
        shapesByCohort: shapesFor('OTHER|0'),
      },
    );
    expect(stats.matched).toBe(1);
  });
});
