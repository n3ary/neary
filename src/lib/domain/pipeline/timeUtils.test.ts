import { describe, expect, it } from 'vitest';
import {
  dateKeyInTz,
  dayOfWeekInTz,
  minSinceMidnightInTz,
  timeToMinutes,
} from './timeUtils';

describe('timeToMinutes', () => {
  it('parses "HH:MM" / "HH:MM:SS" to minutes since midnight', () => {
    expect(timeToMinutes('09:05')).toBe(9 * 60 + 5);
    expect(timeToMinutes('09:05:00')).toBe(9 * 60 + 5);
    expect(timeToMinutes('25:30:00')).toBe(25 * 60 + 30); // GTFS post-midnight
  });
  it('returns NaN for garbage', () => {
    expect(Number.isNaN(timeToMinutes(''))).toBe(true);
    expect(Number.isNaN(timeToMinutes('nope'))).toBe(true);
    expect(Number.isNaN(timeToMinutes('09'))).toBe(true);
  });
});

describe('minSinceMidnightInTz', () => {
  // 2026-06-30T11:42:30Z → Europe/Bucharest is UTC+3 in summer → 14:42 local.
  const utcMs = Date.UTC(2026, 5, 30, 11, 42, 30);

  it('returns minutes since local midnight in the given tz', () => {
    expect(minSinceMidnightInTz(utcMs, 'Europe/Bucharest')).toBe(14 * 60 + 42);
    expect(minSinceMidnightInTz(utcMs, 'UTC')).toBe(11 * 60 + 42);
  });

  it('is stable across repeated calls with the same args (cache hit returns same value)', () => {
    const a = minSinceMidnightInTz(utcMs, 'Europe/Bucharest');
    const b = minSinceMidnightInTz(utcMs, 'Europe/Bucharest');
    expect(a).toBe(b);
  });

  it('recomputes when nowMs changes', () => {
    const t1 = minSinceMidnightInTz(utcMs, 'UTC');
    const t2 = minSinceMidnightInTz(utcMs + 60 * 1000, 'UTC');
    expect(t2).toBe(t1 + 1);
  });

  it('recomputes when timezone changes (does not return stale cached value)', () => {
    const buch = minSinceMidnightInTz(utcMs, 'Europe/Bucharest');
    const utc = minSinceMidnightInTz(utcMs, 'UTC');
    // Bucharest is +3 from UTC in summer 2026.
    expect(buch - utc).toBe(3 * 60);
  });

  it('treats two timestamps in the same second as the same key (sub-second nowMs differences hit the cache)', () => {
    // Callers that compute Date.now() independently in the same
    // batch shouldn't bust the cache. The result resolution is
    // per-minute, so rounding nowMs to the second never changes
    // the output but multiplies cache hit rate.
    const a = minSinceMidnightInTz(utcMs, 'UTC');
    const b = minSinceMidnightInTz(utcMs + 500, 'UTC');
    const c = minSinceMidnightInTz(utcMs + 999, 'UTC');
    expect(a).toBe(b);
    expect(b).toBe(c);
  });
});

describe('dateKeyInTz', () => {
  const utcMs = Date.UTC(2026, 5, 30, 22, 30, 0); // 22:30 UTC = 01:30 next day in Bucharest

  it('returns "YYYYMMDD" in the target tz (post-midnight rollover)', () => {
    expect(dateKeyInTz(utcMs, 'UTC')).toBe('20260630');
    expect(dateKeyInTz(utcMs, 'Europe/Bucharest')).toBe('20260701');
  });

  it('is stable across repeated calls with the same args', () => {
    expect(dateKeyInTz(utcMs, 'UTC')).toBe(dateKeyInTz(utcMs, 'UTC'));
  });
});

describe('dayOfWeekInTz', () => {
  // 2026-06-30 is a Tuesday (verify: 2026 is not a leap year edge; Tue=2).
  const utcMs = Date.UTC(2026, 5, 30, 12, 0, 0);

  it('returns the day index (0=Sun..6=Sat) in the target tz', () => {
    expect(dayOfWeekInTz(utcMs, 'UTC')).toBe(2); // Tuesday
  });

  it('rolls over correctly across timezone day boundary', () => {
    // 23:00 UTC Tuesday → 02:00 Wednesday in Bucharest (UTC+3 summer).
    const lateMs = Date.UTC(2026, 5, 30, 23, 0, 0);
    expect(dayOfWeekInTz(lateMs, 'UTC')).toBe(2);
    expect(dayOfWeekInTz(lateMs, 'Europe/Bucharest')).toBe(3); // Wednesday
  });
});
