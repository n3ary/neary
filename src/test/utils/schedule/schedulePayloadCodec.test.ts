import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  compactifySchedule,
  expandSchedule,
  isCompactSchedulePayload,
} from '../../../utils/schedule/schedulePayloadCodec';
import type { SchedulePayload, ScheduleStopTime } from '../../../types/schedule';

/** A trip's stop times starting (first departure) at `start`, fixed pattern. */
function stopsFrom(start: number): ScheduleStopTime[] {
  return [
    { s: 100, q: 0, a: start, d: start },
    { s: 101, q: 1, a: start + 3, d: start + 4 },
    { s: 102, q: 2, a: start + 8, d: start + 8 },
  ];
}

function payload(stopTimes: Record<string, ScheduleStopTime[]>, tripServiceMap: Record<string, string>): SchedulePayload {
  return {
    version: '2025-01-15T03:00:00Z',
    stopTimes,
    calendar: [],
    calendarExceptions: [],
    tripServiceMap,
  };
}

describe('schedulePayloadCodec', () => {
  it('deduplicates trips that share a relative pattern (differ only by start)', () => {
    const p = payload(
      { A: stopsFrom(300), B: stopsFrom(360), C: stopsFrom(420) },
      { A: 'LV', B: 'LV', C: 'S' },
    );
    const compact = compactifySchedule(p);

    // All three trips share one relative pattern.
    expect(compact.patterns).toHaveLength(1);
    expect(Object.keys(compact.trips)).toEqual(['A', 'B', 'C']);
    expect(compact.trips.A).toEqual({ p: 0, t: 300, s: 'LV' });
    expect(compact.trips.B).toEqual({ p: 0, t: 360, s: 'LV' });
    expect(compact.trips.C).toEqual({ p: 0, t: 420, s: 'S' });
    // Pattern stored as offsets from the trip's first departure.
    expect(compact.patterns[0]).toEqual([
      { s: 100, q: 0, a: 0, d: 0 },
      { s: 101, q: 1, a: 3, d: 4 },
      { s: 102, q: 2, a: 8, d: 8 },
    ]);
  });

  it('round-trips expand(compactify(x)) === x', () => {
    const p: SchedulePayload = {
      ...payload(
        { A: stopsFrom(300), B: stopsFrom(360), D: [{ s: 5, q: 0, a: 600, d: 601 }] },
        { A: 'LV', B: 'LV', D: 'D' },
      ),
      tripRouteMap: { A: 42, B: 42, D: 7 },
      tripHeadsignMap: { A: 'North', B: 'North', D: 'South' },
    };
    expect(expandSchedule(compactifySchedule(p))).toEqual(p);
  });

  it('carries trip→route through compactify/expand', () => {
    const p: SchedulePayload = {
      ...payload({ A: stopsFrom(300), C: stopsFrom(420) }, { A: 'LV', C: 'S' }),
      tripRouteMap: { A: 42, C: 7 },
    };
    const compact = compactifySchedule(p);
    expect(compact.trips.A.r).toBe(42);
    expect(compact.trips.C.r).toBe(7);
    expect(expandSchedule(compact).tripRouteMap).toEqual({ A: 42, C: 7 });
  });

  it('keeps distinct patterns separate', () => {
    const p = payload(
      { A: stopsFrom(300), X: [{ s: 9, q: 0, a: 100, d: 100 }, { s: 8, q: 1, a: 105, d: 105 }] },
      { A: 'LV', X: 'LV' },
    );
    expect(compactifySchedule(p).patterns).toHaveLength(2);
  });

  it('isCompactSchedulePayload distinguishes compact from expanded/malformed', () => {
    const compact = compactifySchedule(payload({ A: stopsFrom(300) }, { A: 'LV' }));
    expect(isCompactSchedulePayload(compact)).toBe(true);
    expect(isCompactSchedulePayload({ version: 'x' })).toBe(false);
    expect(isCompactSchedulePayload({ stopTimes: {}, tripServiceMap: {} })).toBe(false);
    expect(isCompactSchedulePayload(null)).toBe(false);
  });

  // Property: round-trip preserves the payload for arbitrary trips/patterns.
  it('property: round-trips for arbitrary trip sets', () => {
    const stopArb = fc.record({
      s: fc.integer({ min: 0, max: 9999 }),
      q: fc.integer({ min: 0, max: 50 }),
      a: fc.integer({ min: 0, max: 1600 }),
      d: fc.integer({ min: 0, max: 1600 }),
    });
    const tripArb = fc
      .uniqueArray(stopArb, { selector: (x) => x.q, minLength: 1, maxLength: 6 })
      // ensure d >= a per stop and sorted by q is handled by codec
      .map((stops) => stops.map((x) => ({ ...x, d: Math.max(x.a, x.d) })));

    const modelArb = fc.dictionary(
      fc.string({ minLength: 1, maxLength: 6 }),
      fc.record({ stops: tripArb, svc: fc.string({ minLength: 1, maxLength: 4 }) }),
      { minKeys: 0, maxKeys: 8 },
    );

    fc.assert(
      fc.property(modelArb, (model) => {
        const stopTimes: Record<string, ScheduleStopTime[]> = {};
        const tripServiceMap: Record<string, string> = {};
        for (const [tripId, { stops, svc }] of Object.entries(model)) {
          stopTimes[tripId] = stops;
          tripServiceMap[tripId] = svc;
        }
        const p = payload(stopTimes, tripServiceMap);
        const round = expandSchedule(compactifySchedule(p));
        // Each trip's stop times preserved (codec orders by q, which matches input gen).
        for (const tripId of Object.keys(stopTimes)) {
          const expected = [...stopTimes[tripId]].sort((l, r) => l.q - r.q);
          expect(round.stopTimes[tripId]).toEqual(expected);
          expect(round.tripServiceMap[tripId]).toBe(tripServiceMap[tripId]);
        }
      }),
      { numRuns: 100 },
    );
  });
});
