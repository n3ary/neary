import { describe, expect, it, vi } from 'vitest';
import { emptyTripShapeCache, syncTripShapeCache } from './tripShapeCache';
import type { GtfsRepo } from './types';

/** Minimal repo double — only the two methods syncTripShapeCache calls. */
function fakeRepo(opts: {
  shapes?: Record<string, Array<{ lat: number; lon: number }>>;
  distances?: Record<string, number[]>;
} = {}): { repo: GtfsRepo; calls: { shapes: string[][]; distances: string[][] } } {
  const calls = { shapes: [] as string[][], distances: [] as string[][] };
  const repo = {
    getShapesForTrips: vi.fn(async (ids: string[]) => {
      calls.shapes.push([...ids]);
      const out: Record<string, Array<{ lat: number; lon: number }>> = {};
      for (const id of ids) if (opts.shapes?.[id]) out[id] = opts.shapes[id];
      return out;
    }),
    getStopDistancesForTrips: vi.fn(async (ids: string[]) => {
      calls.distances.push([...ids]);
      const out: Record<string, number[]> = {};
      for (const id of ids) if (opts.distances?.[id]) out[id] = opts.distances[id];
      return out;
    }),
  } as unknown as GtfsRepo;
  return { repo, calls };
}

const P = (n: number) => Array.from({ length: n }, (_, i) => ({ lat: i, lon: i }));

describe('syncTripShapeCache', () => {
  it('fetches only trips not already in the cache', async () => {
    const { repo, calls } = fakeRepo({ shapes: { B: P(2), C: P(2) }, distances: { B: [10], C: [20] } });
    const prev = { shapes: { A: P(1) }, stopDistances: { A: [5] } };
    const next = await syncTripShapeCache(repo, ['A', 'B', 'C'], prev);
    // Only B and C were missing.
    expect(calls.shapes).toEqual([['B', 'C']]);
    expect(calls.distances).toEqual([['B', 'C']]);
    // A is preserved by reference (cache hit, no clobber).
    expect(next.shapes.A).toBe(prev.shapes.A);
    expect(next.shapes.B).toBeDefined();
    expect(next.shapes.C).toBeDefined();
  });

  it('does not fetch when every visible trip is already cached', async () => {
    const { repo, calls } = fakeRepo();
    const prev = { shapes: { A: P(1), B: P(2) }, stopDistances: { A: [1], B: [2] } };
    const next = await syncTripShapeCache(repo, ['A', 'B'], prev);
    expect(calls.shapes).toEqual([]);
    expect(calls.distances).toEqual([]);
    expect(next.shapes).toEqual(prev.shapes);
    expect(next.stopDistances).toEqual(prev.stopDistances);
  });

  it('prunes trips that are no longer visible (bounded cache growth)', async () => {
    const { repo } = fakeRepo();
    const prev = {
      shapes: { A: P(1), B: P(2), C: P(3) },
      stopDistances: { A: [1], B: [2], C: [3] },
    };
    const next = await syncTripShapeCache(repo, ['B'], prev);
    expect(Object.keys(next.shapes)).toEqual(['B']);
    expect(Object.keys(next.stopDistances)).toEqual(['B']);
  });

  it('handles an empty visible set without calling the repo', async () => {
    const { repo, calls } = fakeRepo();
    const next = await syncTripShapeCache(repo, [], { shapes: { A: P(1) }, stopDistances: { A: [1] } });
    expect(calls.shapes).toEqual([]);
    expect(next.shapes).toEqual({});
    expect(next.stopDistances).toEqual({});
  });

  it('handles missing entries in the fetch response (worker omits trips with no shape)', async () => {
    // Repo only knows about A; B is requested but worker returns nothing for it.
    const { repo } = fakeRepo({ shapes: { A: P(1) }, distances: { A: [1] } });
    const next = await syncTripShapeCache(repo, ['A', 'B'], emptyTripShapeCache());
    expect(next.shapes.A).toBeDefined();
    expect(next.shapes.B).toBeUndefined();
    expect(next.stopDistances.A).toBeDefined();
    expect(next.stopDistances.B).toBeUndefined();
  });

  it('accepts a Set as input (avoids redundant materialisation in the caller)', async () => {
    const { repo, calls } = fakeRepo({ shapes: { A: P(1) }, distances: { A: [1] } });
    const next = await syncTripShapeCache(repo, new Set(['A']), emptyTripShapeCache());
    expect(calls.shapes).toEqual([['A']]);
    expect(next.shapes.A).toBeDefined();
  });
});
