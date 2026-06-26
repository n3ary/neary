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
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(nowMs);
  const y = parts.find((p) => p.type === 'year')?.value ?? '';
  const m = parts.find((p) => p.type === 'month')?.value ?? '';
  const d = parts.find((p) => p.type === 'day')?.value ?? '';
  return `${y}${m}${d}`;
}

/** Minutes since midnight in the given IANA timezone for a Unix ms timestamp. */
export function minSinceMidnightInTz(nowMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(nowMs);
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return h * 60 + m;
}

/** Day-of-week in the given IANA timezone for a Unix ms timestamp.
 *  Returns 0..6 with 0 = Sunday — same convention as `Date.getDay()`. */
export function dayOfWeekInTz(nowMs: number, timeZone: string): number {
  const wd = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
  }).format(nowMs);
  // Intl returns 'Sun' | 'Mon' | … in the en-US locale.
  const idx = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd);
  return idx >= 0 ? idx : 0;
}

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
 * - `today` / `next-trip` look at the feed's "today" from now-onwards.
 *   Night routes extend the window to a full 24h so post-midnight
 *   trips (GTFS times like 25:30) surface in the list.
 * - `tomorrow` looks at the next calendar day from 00:00 to noon —
 *   the morning is the only thing a commuter ever wants to plan the
 *   night before.
 *
 * Pure: takes a clock value + flags, returns numbers. No reactive
 * dependency.
 */
export function scheduleWindowFor(args: {
  view: 'next-trip' | 'today' | 'tomorrow';
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
      windowMin: 12 * 60,
    };
  }
  return {
    localDate: dateKeyInTz(nowMs, timeZone),
    fromMin: minSinceMidnightInTz(nowMs, timeZone),
    windowMin: isNight ? 24 * 60 : 18 * 60,
  };
}
