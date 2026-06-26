import { describe, expect, it } from 'vitest';
import { distAlongBetween, projectOnPolyline, type Polyline } from './shapeProjection';

// A straight east-west polyline near Cluj (~46.77°N). At this
// latitude, 1° of longitude ≈ 76 km. Vertices roughly 1 km apart so
// math is easy to eyeball.
const STRAIGHT: Polyline = [
  { lat: 46.770, lon: 23.580 }, // 0
  { lat: 46.770, lon: 23.5931 }, // ~1 km east
  { lat: 46.770, lon: 23.6062 }, // ~2 km east
  { lat: 46.770, lon: 23.6193 }, // ~3 km east
];

// An L-shaped polyline: 1 km east, then 1 km north.
const ELBOW: Polyline = [
  { lat: 46.770, lon: 23.580 },
  { lat: 46.770, lon: 23.5931 }, // corner
  { lat: 46.779, lon: 23.5931 }, // ~1 km north (~0.009° lat = 1 km)
];

describe('projectOnPolyline', () => {
  it('returns the start vertex for a point exactly at the origin', () => {
    const out = projectOnPolyline(STRAIGHT[0], STRAIGHT);
    expect(out.distAlongM).toBeCloseTo(0, 0);
    expect(out.perpDistM).toBeCloseTo(0, 0);
    expect(out.segmentIdx).toBe(0);
  });

  it('projects a point dead-center on the second segment', () => {
    // Midpoint of segment 1: between 23.5931 and 23.6062
    const mid = { lat: 46.770, lon: 23.5996 };
    const out = projectOnPolyline(mid, STRAIGHT);
    expect(out.segmentIdx).toBe(1);
    // 1 km (segment 0) + 0.5 km (half of segment 1) ≈ 1500 m
    expect(out.distAlongM).toBeGreaterThan(1400);
    expect(out.distAlongM).toBeLessThan(1600);
    expect(out.perpDistM).toBeLessThan(50);
  });

  it('projects an off-route point perpendicular to its nearest segment', () => {
    // 1 km east of origin, but 100 m north of the polyline.
    const off = { lat: 46.7709, lon: 23.5931 };
    const out = projectOnPolyline(off, STRAIGHT);
    expect(out.perpDistM).toBeGreaterThan(50);
    expect(out.perpDistM).toBeLessThan(150);
    // Along-distance should still be ~1 km (the projection lands at the corner).
    expect(out.distAlongM).toBeGreaterThan(900);
    expect(out.distAlongM).toBeLessThan(1100);
  });

  it('clamps to segment endpoints (does not extrapolate past the polyline)', () => {
    // Way east of the polyline end.
    const past = { lat: 46.770, lon: 23.7 };
    const out = projectOnPolyline(past, STRAIGHT);
    // distAlongM should equal the polyline's total length (~3 km), not more.
    expect(out.distAlongM).toBeGreaterThan(2800);
    expect(out.distAlongM).toBeLessThan(3200);
  });

  it('clamps to start when point is way west', () => {
    const before = { lat: 46.770, lon: 23.5 };
    const out = projectOnPolyline(before, STRAIGHT);
    expect(out.distAlongM).toBeCloseTo(0, 0);
  });

  it('handles an L-shaped polyline (multi-segment with direction change)', () => {
    // A point right at the elbow corner.
    const out = projectOnPolyline(ELBOW[1], ELBOW);
    expect(out.distAlongM).toBeGreaterThan(900);
    expect(out.distAlongM).toBeLessThan(1100);
    expect(out.perpDistM).toBeLessThan(10);
  });

  it('throws on a polyline with fewer than 2 points', () => {
    expect(() => projectOnPolyline({ lat: 0, lon: 0 }, [])).toThrow();
    expect(() => projectOnPolyline({ lat: 0, lon: 0 }, [{ lat: 0, lon: 0 }])).toThrow();
  });
});

describe('distAlongBetween', () => {
  it('is positive when "to" is further along than "from"', () => {
    const from = projectOnPolyline({ lat: 46.770, lon: 23.585 }, STRAIGHT);
    const to = projectOnPolyline({ lat: 46.770, lon: 23.6 }, STRAIGHT);
    expect(distAlongBetween(from, to)).toBeGreaterThan(0);
  });

  it('is negative when "to" is before "from" (vehicle already passed)', () => {
    const from = projectOnPolyline({ lat: 46.770, lon: 23.61 }, STRAIGHT);
    const to = projectOnPolyline({ lat: 46.770, lon: 23.59 }, STRAIGHT);
    expect(distAlongBetween(from, to)).toBeLessThan(0);
  });
});
