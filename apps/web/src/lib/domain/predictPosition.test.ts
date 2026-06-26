import { describe, expect, it } from 'vitest';
import { predictPosition, type PredictStop } from './predictPosition';

const stops: PredictStop[] = [
  { lat: 0, lon: 0, arrivalMin: 100 }, // origin at minute 100
  { lat: 0, lon: 2, arrivalMin: 110 }, // 10 min later
  { lat: 0, lon: 4, arrivalMin: 130 }, // 20 min later (terminus)
];

describe('predictPosition', () => {
  it('returns null for an empty trip', () => {
    expect(predictPosition([], 100)).toBeNull();
  });

  it("returns 'before' + origin when far ahead of the start", () => {
    const p = predictPosition(stops, 50);
    expect(p).toEqual({ lat: 0, lon: 0, status: 'before' });
  });

  it("returns 'at-origin' inside the imminent window", () => {
    const p = predictPosition(stops, 97, 5); // 3 min before origin
    expect(p?.status).toBe('at-origin');
  });

  it("interpolates linearly between consecutive stops ('active')", () => {
    // 5 min past the origin, midway through the first segment.
    const p = predictPosition(stops, 105);
    expect(p?.status).toBe('active');
    expect(p?.lon).toBeCloseTo(1, 6);
    expect(p?.lat).toBeCloseTo(0, 6);
  });

  it('handles zero-length segments without dividing by zero', () => {
    const flat: PredictStop[] = [
      { lat: 0, lon: 0, arrivalMin: 100 },
      { lat: 0, lon: 1, arrivalMin: 100 }, // same minute
      { lat: 0, lon: 2, arrivalMin: 110 },
    ];
    const p = predictPosition(flat, 100);
    expect(p?.status).toBe('active');
    // Either of the two coincident stops is acceptable as the snap.
    expect([0, 1]).toContain(p?.lon);
  });

  it("returns 'after' when the trip has finished", () => {
    const p = predictPosition(stops, 200);
    expect(p).toEqual({ lat: 0, lon: 4, status: 'after' });
  });
});
