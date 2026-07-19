import { describe, expect, it } from 'vitest';
import { measurePolyline } from '@n3ary/gtfs-spec/shape';
import { DEFAULT_FEED_SPEED_CONFIG } from './speedCascade';
import { clockToBucket, DEFAULT_TOD_PROFILE } from './timeOfDay';
import { minSinceMidnightInTz } from './pipeline/timeUtils';
import {
  buildTripShapePlan,
  deadReckonGpsAlongShape,
  predictPosition,
  predictPositionFromGps,
  predictPositionOnShape,
  type PredictStop,
} from './predictPosition';

const stops: PredictStop[] = [
  { lat: 0, lon: 0, arrivalMin: 100 }, // origin at minute 100
  { lat: 0, lon: 2, arrivalMin: 110 }, // 10 min later
  { lat: 0, lon: 4, arrivalMin: 130 }, // 20 min later (terminus)
];

describe('predictPosition (straight-line)', () => {
  it('returns null for an empty trip', () => {
    expect(predictPosition([], 100)).toBeNull();
  });

  it("returns 'before' + origin when far ahead of the start", () => {
    const p = predictPosition(stops, 50);
    expect(p).toEqual({ lat: 0, lon: 0, status: 'before' });
  });

  it("returns 'at-origin' inside the imminent window", () => {
    const p = predictPosition(stops, 97, 5);
    expect(p?.status).toBe('at-origin');
  });

  it("interpolates linearly between consecutive stops ('active')", () => {
    const p = predictPosition(stops, 105);
    expect(p?.status).toBe('active');
    expect(p?.lon).toBeCloseTo(1, 6);
    expect(p?.lat).toBeCloseTo(0, 6);
  });

  it('handles zero-length segments without dividing by zero', () => {
    const flat: PredictStop[] = [
      { lat: 0, lon: 0, arrivalMin: 100 },
      { lat: 0, lon: 1, arrivalMin: 100 },
      { lat: 0, lon: 2, arrivalMin: 110 },
    ];
    const p = predictPosition(flat, 100);
    expect(p?.status).toBe('active');
    expect([0, 1]).toContain(p?.lon);
  });

  it("returns 'after' when the trip has finished", () => {
    const p = predictPosition(stops, 200);
    expect(p).toEqual({ lat: 0, lon: 4, status: 'after' });
  });
});

describe('predictPositionOnShape', () => {
  // A shape that doglegs north between the two end stops, so the
  // shape-aware predictor lands ABOVE the equator at the midpoint,
  // unlike the straight-line variant which would stay on it.
  // Coordinates kept small so haversine math is dominated by the
  // equirectangular approximation; differences are still visible.
  const detourShape = [
    { lat: 0,   lon: 0 },
    { lat: 0.5, lon: 1 }, // detour vertex
    { lat: 0,   lon: 2 },
  ];

  it('returns null when the shape is too short to be useful', () => {
    expect(buildTripShapePlan(stops, [])).toBeNull();
    expect(buildTripShapePlan(stops, [{ lat: 0, lon: 0 }])).toBeNull();
  });

  it('snaps to the polyline midpoint at the time-midway nowMin', () => {
    // A trip with two stops 10 min apart, on a 3-vertex doglegged
    // shape. At half-time, the bus should be near the detour vertex,
    // not on the straight line between the stops.
    const twoStops: PredictStop[] = [
      { lat: 0, lon: 0, arrivalMin: 100 },
      { lat: 0, lon: 2, arrivalMin: 110 },
    ];
    const plan = buildTripShapePlan(twoStops, detourShape);
    expect(plan).not.toBeNull();
    const p = predictPositionOnShape(plan!, 105);
    expect(p?.status).toBe('active');
    // Halfway by time → halfway by distance-along-shape → projected
    // onto the detour, the lat ought to be measurably > 0 (i.e.
    // riding the dogleg). Straight-line would give lat == 0.
    expect(p?.lat).toBeGreaterThan(0.4);
    expect(p?.lat).toBeLessThan(0.6);
  });

  it("returns 'before' at origin point when nowMin is far ahead", () => {
    const plan = buildTripShapePlan(stops, [
      { lat: 0, lon: 0 }, { lat: 0, lon: 4 },
    ])!;
    const p = predictPositionOnShape(plan, 50);
    expect(p?.status).toBe('before');
    expect(p?.lat).toBeCloseTo(0, 6);
    expect(p?.lon).toBeCloseTo(0, 6);
  });

  it("returns 'after' at terminus when the trip has finished", () => {
    const plan = buildTripShapePlan(stops, [
      { lat: 0, lon: 0 }, { lat: 0, lon: 4 },
    ])!;
    const p = predictPositionOnShape(plan, 999);
    expect(p?.status).toBe('after');
    expect(p?.lon).toBeCloseTo(4, 6);
  });

  it('uses pre-populated `distAlongM` and skips polyline projection', () => {
    // When every stop carries distAlongM (build-time `shape_dist_traveled`),
    // buildTripShapePlan must read those values verbatim instead of
    // projecting. Verify by passing intentionally "wrong" distAlongM
    // values — the resulting plan's legs[] should match the inputs,
    // proving the projection branch was skipped.
    const stopsWithDist: PredictStop[] = [
      { lat: 0, lon: 0, arrivalMin: 100, distAlongM: 1234 },
      { lat: 0, lon: 2, arrivalMin: 110, distAlongM: 5678 },
    ];
    const plan = buildTripShapePlan(stopsWithDist, detourShape)!;
    expect(plan.legs).toEqual([
      { arrivalMin: 100, distAlongM: 1234 },
      { arrivalMin: 110, distAlongM: 5678 },
    ]);
  });

  it('falls back to projection when any stop lacks `distAlongM`', () => {
    // Mixed presence → fall back to projecting all stops. Stops 0 and 2
    // carry distAlongM, stop 1 doesn't; expect projection-derived values
    // throughout (not the supplied "garbage" 9999 / 8888 on the carriers).
    const mixed: PredictStop[] = [
      { lat: 0, lon: 0, arrivalMin: 100, distAlongM: 9999 },
      { lat: 0, lon: 2, arrivalMin: 110 },
      { lat: 0, lon: 4, arrivalMin: 130, distAlongM: 8888 },
    ];
    const plan = buildTripShapePlan(mixed, [
      { lat: 0, lon: 0 }, { lat: 0, lon: 4 },
    ])!;
    // distAlongM at origin should be ~0 (start of shape), not 9999.
    expect(plan.legs[0].distAlongM).toBeLessThan(100);
    // distAlongM at terminus should be ~full polyline length, not 8888.
    expect(plan.legs[2].distAlongM).toBeGreaterThan(100);
    expect(plan.legs[2].distAlongM).toBeLessThan(500_000); // ~4° at equator
  });
});

describe('predictPositionFromGps', () => {
  // Same dogleg as predictPositionOnShape tests so we can reuse the
  // intuition: shape goes (0,0) → (0.5,1) → (0,2).
  const twoStops: PredictStop[] = [
    { lat: 0, lon: 0, arrivalMin: 100 },
    { lat: 0, lon: 2, arrivalMin: 110 },
  ];
  const detourShape = [
    { lat: 0, lon: 0 },
    { lat: 0.5, lon: 1 },
    { lat: 0, lon: 2 },
  ];
  const plan = buildTripShapePlan(twoStops, detourShape)!;
  const NOW = 1_700_000_000_000;

  it('returns null when the GPS fix is older than 15 min', () => {
    const out = predictPositionFromGps(
      plan,
      { lat: 0.5, lon: 1, speedMs: 5, asOfMs: NOW - 16 * 60_000 },
      NOW,
    );
    expect(out).toBeNull();
  });

  it("flags a < 3 min fix as 'fresh'", () => {
    const out = predictPositionFromGps(
      plan,
      { lat: 0.5, lon: 1, speedMs: null, asOfMs: NOW - 30_000 },
      NOW,
    );
    expect(out?.freshness).toBe('fresh');
    expect(out?.status).toBe('active');
  });

  it('holds an observed stop while the fix is fresh (one dwell cycle)', () => {
    // Bus reported stopped 30 s ago (speedMs 0). Walking it forward
    // at the TOD speed would skate it past the stop it's sitting at
    // and flip the board to the next trip — so it holds.
    const fix = { lat: 0, lon: 0, speedMs: 0, asOfMs: NOW - 30_000 };
    const fresh = predictPositionFromGps(plan, fix, NOW)!;
    expect(fresh.freshness).toBe('fresh');
    expect(fresh.lon).toBeCloseTo(0, 10);
  });

  it('resumes the TOD walk once a stopped report is past its hold', () => {
    // Same stopped report, now 90 s old: the bus has likely left, so
    // it walks at the TOD speed for the time past STOP_HOLD_MS.
    const held = predictPositionFromGps(
      plan,
      { lat: 0, lon: 0, speedMs: 0, asOfMs: NOW - 30_000 },
      NOW,
    )!;
    const resumed = predictPositionFromGps(
      plan,
      { lat: 0, lon: 0, speedMs: 0, asOfMs: NOW - 90_000 },
      NOW,
    )!;
    expect(held.lon).toBeCloseTo(0, 10);
    expect(resumed.lon).toBeGreaterThan(0);
    // ...and a 10-min-old stopped report keeps advancing at the TOD
    // speed like any silent bus — the hold only sets it 45 s back,
    // it never freezes in place.
    const longAgo = predictPositionFromGps(
      plan,
      { lat: 0, lon: 0, speedMs: 0, asOfMs: NOW - 10 * 60_000 },
      NOW,
    )!;
    expect(longAgo.lon).toBeGreaterThan(resumed.lon);
  });

  it("flags a 5–15 min fix as 'very-stale' and still extrapolates at the TOD speed", () => {
    const fix = { lat: 0, lon: 0, speedMs: null, asOfMs: NOW - 10 * 60_000 };
    const out = predictPositionFromGps(plan, fix, NOW)!;
    expect(out.freshness).toBe('very-stale');
    expect(out.status).toBe('active');
    expect(out.lon).toBeGreaterThan(0);
  });

  it('walks the full fix age — observed speed first, TOD beyond the horizon', () => {
    // Feed glitches routinely last minutes; freezing at 90 s would
    // show stale-high ETAs during the silence, then jump on recovery.
    // Same explicit speed: the 10-min fix must advance well past the
    // 91-s one (90 s observed + the rest at TOD), never freeze.
    const justPast = predictPositionFromGps(
      plan,
      { lat: 0, lon: 0, speedMs: 20, asOfMs: NOW - 91_000 },
      NOW,
    )!;
    const longAgo = predictPositionFromGps(
      plan,
      { lat: 0, lon: 0, speedMs: 20, asOfMs: NOW - 10 * 60_000 },
      NOW,
    )!;
    expect(longAgo.lon).toBeGreaterThan(justPast.lon);
    // But the far past is still abandoned to the schedule fallback.
    expect(
      predictPositionFromGps(
        plan,
        { lat: 0, lon: 0, speedMs: 20, asOfMs: NOW - 16 * 60_000 },
        NOW,
      ),
    ).toBeNull();
  });

  it('uses the TOD speed, not the stale observed speed, past the horizon', () => {
    // Fix 100 s old at an observed 5 m/s: segment 1 (90 s) reaches the
    // 400 m stop mid-dwell (80 s drive + 10 s into the 20 s dwell);
    // segment 2 (10 s) must advance at the TOD bucket speed, not the
    // observed 5 m/s — a minutes-old observed speed is obsolete.
    const measured = measurePolyline([{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }]);
    const out = deadReckonGpsAlongShape(
      { lat: 0, lon: 0, speedMs: 5, asOfMs: NOW - 100_000 },
      measured,
      NOW,
      {},
      { stopDistAlongM: [400], dwellSecondsPerStop: 20 },
    )!;
    const bucket = clockToBucket(minSinceMidnightInTz(NOW, 'UTC'), DEFAULT_TOD_PROFILE);
    const todKmh = DEFAULT_FEED_SPEED_CONFIG[`kmh_${bucket}`];
    expect(out.distAlongM).toBeCloseTo(400 + 10 * (todKmh / 3.6), 0);
    // All default TOD buckets (15/25/30 km/h) differ from 5 m/s, so
    // this pins the segment-2 speed unambiguously.
    expect(out.distAlongM).not.toBeCloseTo(450, 0);
  });

  it('dead-reckons faster with an explicit speed than with the TOD fallback', () => {
    const fix = { lat: 0, lon: 0, asOfMs: NOW - 30_000 };
    const todWalk = predictPositionFromGps(
      plan,
      { ...fix, speedMs: null },
      NOW,
    )!;
    const moving = predictPositionFromGps(
      plan,
      { ...fix, speedMs: 50 },
      NOW,
    )!;
    // Both walk forward along the shape; the explicit-speed fix
    // (180 km/h equivalent) should land further along than the TOD
    // fallback (~22 km/h offpeak default).
    expect(todWalk.lon).toBeGreaterThan(0);
    expect(moving.lon).toBeGreaterThan(todWalk.lon);
  });

  it('pays dwell at stops the walk crosses instead of skating past for free', () => {
    // ~111 km straight line; fix at the start, 90 s old, 5 m/s.
    // Naive walk would cover 450 m and cross the 400 m stop.
    // Dwell-aware: drive 400 m = 80 s, then the remaining 10 s is
    // inside the 20 s dwell → the bus is AT the 400 m stop, not
    // 50 m past it.
    const measured = measurePolyline([{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }]);
    const out = deadReckonGpsAlongShape(
      { lat: 0, lon: 0, speedMs: 5, asOfMs: NOW - 90_000 },
      measured,
      NOW,
      {},
      { stopDistAlongM: [400, 800, 1200], dwellSecondsPerStop: 20 },
    )!;
    expect(out.distAlongM).toBeCloseTo(400, 0);
  });

  it('consumes dwell at every crossed stop when the budget allows several', () => {
    // Same line; stops at 100/200/300 m, 90 s budget at 5 m/s.
    // Naive: 450 m. Dwell-aware: 20 s drive + 20 s dwell per stop →
    // 100 m (rem 50) → 200 m (rem 10) → 50 m past it = 250 m.
    const measured = measurePolyline([{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }]);
    const out = deadReckonGpsAlongShape(
      { lat: 0, lon: 0, speedMs: 5, asOfMs: NOW - 90_000 },
      measured,
      NOW,
      {},
      { stopDistAlongM: [100, 200, 300], dwellSecondsPerStop: 20 },
    )!;
    expect(out.distAlongM).toBeCloseTo(250, 0);
  });

  it('falls back to the naive walk when no stop distances are known', () => {
    // Orphans / feeds without per-stop distances keep the plain
    // speed × time walk: 90 s × 5 m/s = 450 m.
    const measured = measurePolyline([{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }]);
    const out = deadReckonGpsAlongShape(
      { lat: 0, lon: 0, speedMs: 5, asOfMs: NOW - 90_000 },
      measured,
      NOW,
    )!;
    expect(out.distAlongM).toBeCloseTo(450, 0);
  });

  it('caps dead-reckoning so an outlier speed cannot overshoot the terminus', () => {
    // Speed × dt would otherwise project far past the cap, but the
    // result must still land on the polyline (clamped to total
    // distance) — never past it.
    const out = predictPositionFromGps(
      plan,
      { lat: 0, lon: 0, speedMs: 1_000, asOfMs: NOW - 2 * 60_000 + 1 },
      NOW,
    )!;
    expect(out.freshness).toBe('fresh');
    // Position must remain on the shape's lon range [0, 2].
    expect(out.lon).toBeGreaterThanOrEqual(0);
    expect(out.lon).toBeLessThanOrEqual(2);
  });
});
