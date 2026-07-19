import { describe, expect, it, vi } from 'vitest';
import type { ScheduleTripStop } from './types';

// 2023-11-14T22:13:20Z — a fixed clock for deterministic local minutes.
const NOW = 1_700_000_000_000;

const stops: ScheduleTripStop[] = [
  { stopId: 'A', stopName: 'Alpha', lat: 0, lon: 0.001, arrivalTime: '22:00:00', arrivalMin: 1320, stopSequence: 1, distAlongM: 100 },
  { stopId: 'B', stopName: 'Beta', lat: 0, lon: 0.005, arrivalTime: '22:04:00', arrivalMin: 1324, stopSequence: 2, distAlongM: 500 },
  { stopId: 'C', stopName: 'Gamma', lat: 0, lon: 0.010, arrivalTime: '22:09:00', arrivalMin: 1329, stopSequence: 3, distAlongM: 1000 },
];

const shape = [
  { lat: 0, lon: 0 },
  { lat: 0, lon: 0.02 },
];

const repo = {
  getStopsAlongRouteDir: vi.fn(async () => stops),
  getShapeForRouteDir: vi.fn(async () => shape as typeof shape | null),
};

vi.mock('./repo', () => ({
  getGtfsRepo: () => repo,
}));

const { getUpcomingStopsForRouteDir } = await import('./upcomingStops');

describe('getUpcomingStopsForRouteDir', () => {
  it('slices stops after the current station; no estimates without live context', async () => {
    const out = await getUpcomingStopsForRouteDir('24B', 1, 'A');
    expect(out.map((s) => s.stopId)).toEqual(['B', 'C']);
    expect(out.every((s) => s.estimated == null)).toBe(true);
  });

  it('estimates per-stop times from the live fix, later stops later', async () => {
    const out = await getUpcomingStopsForRouteDir('24B', 1, 'A', {
      obs: { lat: 0, lon: 0, speedMs: 5, asOfMs: NOW },
      nowMs: NOW,
      timezone: 'UTC',
    });
    const [b, c] = out;
    // Fresh fix at the shape origin moving 5 m/s: B ≈ 556 m ahead
    // plus one dwell at A, C ≈ 1.1 km plus two — both estimates,
    // anchored to local "now" (22:13 UTC = 1333 min), increasing.
    expect(b.estimated).toBe(true);
    expect(c.estimated).toBe(true);
    expect(b.arrivalMin).toBeGreaterThanOrEqual(1333);
    expect(b.arrivalMin).toBeLessThan(1338);
    expect(c.arrivalMin).toBeGreaterThan(b.arrivalMin);
    // Estimates overwrite the rep trip's scheduled times, not append.
    expect(b.arrivalMin).not.toBe(1324);
  });

  it('skips estimation when the fix is too old to trust', async () => {
    const out = await getUpcomingStopsForRouteDir('24B', 1, 'A', {
      obs: { lat: 0, lon: 0, speedMs: 5, asOfMs: NOW - 16 * 60_000 },
      nowMs: NOW,
      timezone: 'UTC',
    });
    expect(out.map((s) => s.stopId)).toEqual(['B', 'C']);
    expect(out.every((s) => s.estimated == null)).toBe(true);
  });

  it('skips estimation when the direction has no shape', async () => {
    repo.getShapeForRouteDir.mockResolvedValueOnce(null);
    const out = await getUpcomingStopsForRouteDir('24B', 1, 'A', {
      obs: { lat: 0, lon: 0, speedMs: 5, asOfMs: NOW },
      nowMs: NOW,
      timezone: 'UTC',
    });
    expect(out.map((s) => s.stopId)).toEqual(['B', 'C']);
    expect(out.every((s) => s.estimated == null)).toBe(true);
  });
});
