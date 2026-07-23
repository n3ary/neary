/*
 * Pure-function tests for the frequency-expansion helper. No DB
 * required — `expandFrequencyToDepartures` is the load-bearing
 * function (one bug here propagates to every per-time query) and
 * it's purely arithmetic on minutes-since-midnight.
 */

import { describe, it, expect } from 'vitest';
import {
  expandFrequencyToDepartures,
  expandFrequenciesToDepartures,
  type FrequencyRow,
} from './frequencyExpansion';

const F = (
  partial: Partial<FrequencyRow> & Pick<FrequencyRow, 'start_time' | 'end_time' | 'headway_secs'>,
): FrequencyRow => ({
  trip_id: 'T_FREQ',
  exact_times: 0,
  ...partial,
});

describe('expandFrequencyToDepartures', () => {
  it('emits one departure per headway within the window', () => {
    // 15-min headway, 05:05 - 22:40, window 05:00 - 23:00.
    // 05:05, 05:20, 05:35, ..., 22:20, 22:35 (NOT 22:50 — past 22:40 exclusive).
    // First 5: 5:05, 5:20, 5:35, 5:50, 6:05.
    // Last 5 in window: 21:50, 22:05, 22:20, 22:35 (and 22:50 excluded).
    const deps = expandFrequencyToDepartures(
      F({ start_time: '05:05:00', end_time: '22:40:00', headway_secs: 900 }),
      5 * 60,
      23 * 60,
    );
    expect(deps[0]).toEqual({ effectiveStartMin: 5 * 60 + 5, k: 0 });
    expect(deps[1]).toEqual({ effectiveStartMin: 5 * 60 + 20, k: 1 });
    expect(deps[2]).toEqual({ effectiveStartMin: 5 * 60 + 35, k: 2 });
    // Last one: 22:35 (k = (22*60+35 - 5*60-5) / 15 = 17*60+30 / 15 = 70).
    const last = deps[deps.length - 1]!;
    expect(last.effectiveStartMin).toBe(22 * 60 + 35);
    expect(last.k).toBe(70);
    // Total: 71 departures (k=0..70).
    expect(deps).toHaveLength(71);
  });

  it('excludes the end_time-bound departure (per spec: "up to but not including end_time")', () => {
    // 10-min headway, 05:00 - 05:30. Departures: 5:00, 5:10, 5:20 (5:30 excluded).
    const deps = expandFrequencyToDepartures(
      F({ start_time: '05:00:00', end_time: '05:30:00', headway_secs: 600 }),
      0,
      24 * 60,
    );
    expect(deps.map((d) => d.effectiveStartMin)).toEqual([5 * 60, 5 * 60 + 10, 5 * 60 + 20]);
  });

  it('clamps the start of the window (does not generate departures before windowStartMin)', () => {
    // 15-min headway, 05:00 - 22:00, query window 07:30 - 09:00.
    // First departure at 07:30 (k=10), last at 09:00 (k=16, inclusive
    // upper bound per the same convention as `getActiveTrips`).
    const deps = expandFrequencyToDepartures(
      F({ start_time: '05:00:00', end_time: '22:00:00', headway_secs: 900 }),
      7 * 60 + 30,
      9 * 60,
    );
    expect(deps[0]?.effectiveStartMin).toBe(7 * 60 + 30);
    expect(deps[deps.length - 1]?.effectiveStartMin).toBe(9 * 60);
    // 07:30, 07:45, 08:00, 08:15, 08:30, 08:45, 09:00 = 7 departures.
    expect(deps).toHaveLength(7);
  });

  it('handles frequencies that cross midnight (end_time > 24:00:00)', () => {
    // Night-route: 23:00 - 26:00 (i.e. 02:00 next day), 30-min headway.
    // Departures: 23:00, 23:30, 00:00, 00:30, 01:00, 01:30 (02:00 excluded).
    // 23:00 = 23*60 = 1380. 26:00 = 26*60 = 1560. Headway = 30 min.
    // k in [0, 6), effective 1380, 1410, 1440, 1470, 1500, 1530.
    const deps = expandFrequencyToDepartures(
      F({ start_time: '23:00:00', end_time: '26:00:00', headway_secs: 1800 }),
      0,
      30 * 60,
    );
    expect(deps.map((d) => d.effectiveStartMin)).toEqual([
      23 * 60, 23 * 60 + 30,
      24 * 60, 24 * 60 + 30,
      25 * 60, 25 * 60 + 30,
    ]);
  });

  it('returns [] when the window does not intersect the frequency window', () => {
    // Frequency 10:00 - 12:00, query window 14:00 - 15:00 (no overlap).
    expect(expandFrequencyToDepartures(
      F({ start_time: '10:00:00', end_time: '12:00:00', headway_secs: 600 }),
      14 * 60, 15 * 60,
    )).toEqual([]);
    // Same freq, query window 13:00 - 14:00 — still no overlap.
    expect(expandFrequencyToDepartures(
      F({ start_time: '10:00:00', end_time: '12:00:00', headway_secs: 600 }),
      13 * 60, 14 * 60,
    )).toEqual([]);
  });

  it('returns [] on garbage input (defence in depth — DDL CHECKs already reject these)', () => {
    // Unparseable start_time.
    expect(expandFrequencyToDepartures(
      F({ start_time: 'not-a-time', end_time: '22:00:00', headway_secs: 900 }),
      0, 24 * 60,
    )).toEqual([]);
    // Unparseable end_time.
    expect(expandFrequencyToDepartures(
      F({ start_time: '05:00:00', end_time: 'garbage', headway_secs: 900 }),
      0, 24 * 60,
    )).toEqual([]);
    // end_time <= start_time.
    expect(expandFrequencyToDepartures(
      F({ start_time: '10:00:00', end_time: '10:00:00', headway_secs: 600 }),
      0, 24 * 60,
    )).toEqual([]);
    expect(expandFrequencyToDepartures(
      F({ start_time: '11:00:00', end_time: '10:00:00', headway_secs: 600 }),
      0, 24 * 60,
    )).toEqual([]);
    // Non-positive headway.
    expect(expandFrequencyToDepartures(
      F({ start_time: '05:00:00', end_time: '22:00:00', headway_secs: 0 }),
      0, 24 * 60,
    )).toEqual([]);
    expect(expandFrequencyToDepartures(
      F({ start_time: '05:00:00', end_time: '22:00:00', headway_secs: -60 }),
      0, 24 * 60,
    )).toEqual([]);
  });

  it('handles a 1-minute headway (M26 case) without floating-point drift', () => {
    // 60-second headway, 05:00 - 05:10. Departures: 5:00, 5:01, ..., 5:09 (10 of them).
    const deps = expandFrequencyToDepartures(
      F({ start_time: '05:00:00', end_time: '05:10:00', headway_secs: 60 }),
      0, 24 * 60,
    );
    expect(deps).toHaveLength(10);
    expect(deps[0]?.effectiveStartMin).toBe(5 * 60);
    expect(deps[9]?.effectiveStartMin).toBe(5 * 60 + 9);
  });
});

describe('expandFrequenciesToDepartures', () => {
  it('groups generated departures by trip_id, omitting trips with no in-window departures', () => {
    const freqs: FrequencyRow[] = [
      F({ trip_id: 'A', start_time: '05:00:00', end_time: '22:00:00', headway_secs: 900 }),
      // B's window doesn't intersect the query window — should be omitted.
      F({ trip_id: 'B', start_time: '02:00:00', end_time: '04:00:00', headway_secs: 600 }),
    ];
    const out = expandFrequenciesToDepartures(freqs, 5 * 60, 23 * 60);
    expect(out.has('A')).toBe(true);
    expect(out.has('B')).toBe(false);
    expect(out.get('A')?.[0]?.effectiveStartMin).toBe(5 * 60);
  });
});
