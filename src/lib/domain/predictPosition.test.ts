import { describe, expect, it } from 'vitest';
import {
  buildTripShapePlan,
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

  it('returns null when the GPS fix is older than 5 min', () => {
    const out = predictPositionFromGps(
      plan,
      { lat: 0.5, lon: 1, speedMs: 5, asOfMs: NOW - 6 * 60_000 },
      NOW,
    );
    expect(out).toBeNull();
  });

  it("flags a < 2 min fix as 'fresh'", () => {
    const out = predictPositionFromGps(
      plan,
      { lat: 0.5, lon: 1, speedMs: null, asOfMs: NOW - 30_000 },
      NOW,
    );
    expect(out?.freshness).toBe('fresh');
    expect(out?.status).toBe('active');
  });

  it("flags a 2–5 min fix as 'stale' and skips dead-reckoning", () => {
    const fix = { lat: 0.5, lon: 1, speedMs: 20, asOfMs: NOW - 3 * 60_000 };
    const stale = predictPositionFromGps(plan, fix, NOW)!;
    expect(stale.freshness).toBe('stale');
    // Same call without speed should land on the same point — proves
    // the stale path didn't extrapolate using speed.
    const noSpeed = predictPositionFromGps(
      plan,
      { ...fix, speedMs: null },
      NOW,
    )!;
    expect(stale.lat).toBeCloseTo(noSpeed.lat, 9);
    expect(stale.lon).toBeCloseTo(noSpeed.lon, 9);
  });

  it('dead-reckons forward along the shape when fresh + speed > 0', () => {
    const fix = { lat: 0, lon: 0, asOfMs: NOW - 30_000 };
    const still = predictPositionFromGps(
      plan,
      { ...fix, speedMs: null },
      NOW,
    )!;
    const moving = predictPositionFromGps(
      plan,
      { ...fix, speedMs: 50 },
      NOW,
    )!;
    // Moving fix should have advanced along the shape (lon increases
    // monotonically along the polyline). With null speed it sits at origin.
    expect(still.lon).toBeCloseTo(0, 6);
    expect(moving.lon).toBeGreaterThan(still.lon);
  });

  it('caps dead-reckoning so an outlier speed cannot overshoot the terminus', () => {
    // Speed × dt would otherwise project far past the 3 km cap, but
    // the result must still land on the polyline (clamped to total
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
