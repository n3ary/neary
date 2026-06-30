/*
 * Time utilities shared by pipeline stages. Pure functions.
 */

/** Convert a GTFS time string "HH:MM:SS" (24h+ allowed for past-midnight
 *  trips) to minutes since midnight. Returns NaN on garbage. */
export function timeToMinutes(t: string): number {
  if (!t) return Number.NaN;
  const parts = t.split(':');
  if (parts.length < 2) return Number.NaN;
  const h = Number(parts[0]);
  const m = Number(parts[1]);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return Number.NaN;
  return h * 60 + m;
}

/** Format a `Date` (system-local) as GTFS calendar key "YYYYMMDD". */
export function localDateKey(d: Date): string {
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${y}${mo}${da}`;
}

/** Minutes since local (system) midnight for a `Date`. */
export function localMinSinceMidnight(d: Date): number {
  return d.getHours() * 60 + d.getMinutes();
}

/**
 * "YYYYMMDD" for a Unix ms timestamp evaluated in a given IANA timezone.
 * Used by the worker so the GTFS calendar query uses the feed's local date
 * (e.g. Europe/Bucharest for Cluj) regardless of where the user's system
 * clock is. Built on Intl.DateTimeFormat so it works in workers.
 */
export function dateKeyInTz(nowMs: number, timeZone: string): string {
  const sec = Math.floor(nowMs / 1000);
  if (dateKeyCache && dateKeyCache.sec === sec && dateKeyCache.tz === timeZone) {
    return dateKeyCache.value;
  }
  const parts = dateKeyFormatter(timeZone).formatToParts(sec * 1000);
  const y = parts.find((p) => p.type === 'year')?.value ?? '';
  const m = parts.find((p) => p.type === 'month')?.value ?? '';
  const d = parts.find((p) => p.type === 'day')?.value ?? '';
  const value = `${y}${m}${d}`;
  dateKeyCache = { sec, tz: timeZone, value };
  return value;
}

/** Minutes since midnight in the given IANA timezone for a Unix ms timestamp. */
export function minSinceMidnightInTz(nowMs: number, timeZone: string): number {
  const sec = Math.floor(nowMs / 1000);
  if (minSinceMidnightCache && minSinceMidnightCache.sec === sec && minSinceMidnightCache.tz === timeZone) {
    return minSinceMidnightCache.value;
  }
  const parts = minSinceMidnightFormatter(timeZone).formatToParts(sec * 1000);
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  const value = h * 60 + m;
  minSinceMidnightCache = { sec, tz: timeZone, value };
  return value;
}

/** Day-of-week in the given IANA timezone for a Unix ms timestamp.
 *  Returns 0..6 with 0 = Sunday — same convention as `Date.getDay()`. */
export function dayOfWeekInTz(nowMs: number, timeZone: string): number {
  const sec = Math.floor(nowMs / 1000);
  if (dayOfWeekCache && dayOfWeekCache.sec === sec && dayOfWeekCache.tz === timeZone) {
    return dayOfWeekCache.value;
  }
  const wd = dayOfWeekFormatter(timeZone).format(sec * 1000);
  // Intl returns 'Sun' | 'Mon' | … in the en-US locale.
  const idx = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd);
  const value = idx >= 0 ? idx : 0;
  dayOfWeekCache = { sec, tz: timeZone, value };
  return value;
}

// === Intl.DateTimeFormat caching ==========================================
// Hot-path optimisation. `new Intl.DateTimeFormat(...)` is expensive
// (~0.5–2 ms per construction on Safari/V8); `formatToParts()` on a cached
// instance is O(µs). Pre-fix profiling (2026-06-30) saw
// `minSinceMidnightInTz` at 5113 ms self-time across one ~6 s recording —
// `pickWalkKmh` in predictPosition.ts calls it inside the GPS
// dead-reckoning loop, once per GPS-only vehicle per reactive cycle.
//
// Two layers:
//   1. Formatter cache keyed by timeZone — one Intl instance per (function, tz).
//   2. Single-entry result cache keyed by (Math.floor(nowMs/1000), timeZone).
//      All three outputs (date key, minute-since-midnight, day-of-week) are
//      coarser than 1 s, so rounding nowMs to the second never changes the
//      result but lets unrelated callers that computed `Date.now()` a few
//      milliseconds apart still hit the cache.

const dateKeyFormatters = new Map<string, Intl.DateTimeFormat>();
function dateKeyFormatter(tz: string): Intl.DateTimeFormat {
  let f = dateKeyFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    dateKeyFormatters.set(tz, f);
  }
  return f;
}

const minSinceMidnightFormatters = new Map<string, Intl.DateTimeFormat>();
function minSinceMidnightFormatter(tz: string): Intl.DateTimeFormat {
  let f = minSinceMidnightFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    minSinceMidnightFormatters.set(tz, f);
  }
  return f;
}

const dayOfWeekFormatters = new Map<string, Intl.DateTimeFormat>();
function dayOfWeekFormatter(tz: string): Intl.DateTimeFormat {
  let f = dayOfWeekFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' });
    dayOfWeekFormatters.set(tz, f);
  }
  return f;
}

let dateKeyCache: { sec: number; tz: string; value: string } | null = null;
let minSinceMidnightCache: { sec: number; tz: string; value: number } | null = null;
let dayOfWeekCache: { sec: number; tz: string; value: number } | null = null;

/** A day-window query against the GTFS schedule: which calendar day,
 *  what cutoff (minutes since local midnight), how far ahead to look. */
export interface ScheduleWindow {
  localDate: string;
  fromMin: number;
  windowMin: number;
}

/**
 * Compute the day + minute window the Schedule view should query.
 *
 * - `today` looks at the feed's "today" from now-onwards.
 *   Night routes extend the window to a full 24h so post-midnight
 *   trips (GTFS times like 25:30) surface in the list.
 * - `tomorrow` looks at the full next calendar day from 00:00. Day
 *   routes get a 24h window (00:00–24:00); night routes get 28h so
 *   the post-midnight tail of tomorrow's service day (24:30, 25:00,
 *   …) still surfaces. The old morning-only window was wrong for
 *   night routes whose only meaningful runs start at 23:00+.
 *
 * Pure: takes a clock value + flags, returns numbers. No reactive
 * dependency.
 */
export function scheduleWindowFor(args: {
  view: 'today' | 'tomorrow';
  isNight: boolean;
  nowMs: number;
  timeZone: string;
}): ScheduleWindow {
  const { view, isNight, nowMs, timeZone } = args;
  if (view === 'tomorrow') {
    const tomorrowMs = nowMs + 24 * 60 * 60 * 1000;
    return {
      localDate: dateKeyInTz(tomorrowMs, timeZone),
      fromMin: 0,
      windowMin: isNight ? 28 * 60 : 24 * 60,
    };
  }
  return {
    localDate: dateKeyInTz(nowMs, timeZone),
    fromMin: minSinceMidnightInTz(nowMs, timeZone),
    windowMin: isNight ? 24 * 60 : 18 * 60,
  };
}
