// Time utilities shared by pipeline stages. Pure functions.

import { appLocale } from '../../i18n/locale';

/** Convert a GTFS time string "HH:MM:SS" (24h+ for past-midnight trips) to minutes since midnight. Returns NaN on garbage. */
export function timeToMinutes(t: string): number {
  if (!t) return Number.NaN;
  const parts = t.split(':');
  if (parts.length < 2) return Number.NaN;
  const h = Number(parts[0]);
  const m = Number(parts[1]);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return Number.NaN;
  return h * 60 + m;
}

/** Inverse of `timeToMinutes`. Seconds field is always 00 — GTFS schedules are minute-precision. Empty string on garbage. */
export function minutesToTime(min: number): string {
  if (!Number.isFinite(min) || min < 0) return '';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
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

/** "YYYYMMDD" for a Unix ms timestamp evaluated in a given IANA timezone. The worker uses this so the GTFS calendar query runs on the feed's local date (the tz is per-feed) regardless of where the user's system clock is. Built on Intl.DateTimeFormat so it works in workers. */
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

/** Day-of-week (0=Sun, 6=Sat) in the given IANA timezone. Uses the formatter's numeric (y, m, d) parts (not the locale-dependent string) so output is locale-independent. */
export function dayOfWeekInTz(nowMs: number, timeZone: string): number {
  const sec = Math.floor(nowMs / 1000);
  if (dayOfWeekCache && dayOfWeekCache.sec === sec && dayOfWeekCache.tz === timeZone) {
    return dayOfWeekCache.value;
  }
  const parts = dateKeyFormatter(timeZone).formatToParts(sec * 1000);
  const y = Number(parts.find((p) => p.type === 'year')?.value ?? 0);
  const m = Number(parts.find((p) => p.type === 'month')?.value ?? 0);
  const d = Number(parts.find((p) => p.type === 'day')?.value ?? 0);
  // UTC anchor is intentional — a system-tz offset would bump the weekday by ±1 across DST or odd locales.
  const value = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  dayOfWeekCache = { sec, tz: timeZone, value };
  return value;
}

// Intl.DateTimeFormat caching — new instance is expensive (~0.5-2 ms on Safari/V8); formatToParts on a cached instance is O(µs). Pre-fix profiling (2026-06-30) saw `minSinceMidnightInTz` at 5113 ms self-time in a 6 s recording because pickWalkKmh calls it inside the GPS dead-reckoning loop. Two layers: formatter cache per (function, tz), and a single-entry result cache keyed by (floor(nowMs/1000), tz) — all three outputs are coarser than 1 s so rounding nowMs keeps unrelated callers hitting the cache.

const dateKeyFormatters = new Map<string, Intl.DateTimeFormat>();
function dateKeyFormatter(tz: string): Intl.DateTimeFormat {
  let f = dateKeyFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat(appLocale(), {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      numberingSystem: 'latn',
    });
    dateKeyFormatters.set(tz, f);
  }
  return f;
}

const minSinceMidnightFormatters = new Map<string, Intl.DateTimeFormat>();
function minSinceMidnightFormatter(tz: string): Intl.DateTimeFormat {
  let f = minSinceMidnightFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat(appLocale(), {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      numberingSystem: 'latn',
    });
    minSinceMidnightFormatters.set(tz, f);
  }
  return f;
}

let dateKeyCache: { sec: number; tz: string; value: string } | null = null;
let minSinceMidnightCache: { sec: number; tz: string; value: number } | null = null;
let dayOfWeekCache: { sec: number; tz: string; value: number } | null = null;

/** A day-window query against the GTFS schedule: which calendar day, what cutoff (minutes since local midnight), how far ahead to look. */
export interface ScheduleWindow {
  localDate: string;
  fromMin: number;
  windowMin: number;
}

/** Compute the day + minute window the Schedule view should query. Night routes get full 24h (today) / 28h (tomorrow) so post-midnight trips (GTFS times like 25:30) surface; day routes get 18h (today) / 24h (tomorrow). Pure. */
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
