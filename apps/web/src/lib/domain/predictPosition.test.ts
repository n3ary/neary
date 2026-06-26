import { describe, expect, it } from 'vitest';
import {
  buildTripShapePlan,
  predictPosition,
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
