/*
 * timeOfDay — resolve a clock minute to a `peak | offpeak | night`
 * bucket against a feed's profile. Used by the speed cascade (Tier 3).
 *
 * Pure. No I/O.
 */

export type TodBucket = 'peak' | 'offpeak' | 'night';

export interface TodProfile {
  /** Each window is an inclusive-start, exclusive-end HH:MM pair on a
   *  weekday — the build-time config is already day-typed, so we don't
   *  thread day-of-week here. Treat all listed windows as candidates
   *  every day. */
  peak_windows: ReadonlyArray<{ from: string; to: string }>;
  /** Single window that may wrap midnight (e.g. 22:30 → 05:30). */
  night_window: { from: string; to: string };
}

/** Generic fallback profile used when a feed's blob has no `_neary_config`
 *  table or no `timing` key. Values are a rough approximation of a typical
 *  European urban network — good enough to avoid catastrophic speed estimates
 *  but not tuned to any specific city. Feed-specific values always win and
 *  are written by the neary-gtfs pipeline into `_neary_config`. */
export const DEFAULT_TOD_PROFILE: TodProfile = {
  peak_windows: [
    { from: '07:30', to: '09:00' },
    { from: '16:30', to: '18:30' },
  ],
  night_window: { from: '23:00', to: '05:00' },
};

/** Resolve which bucket `localMin` (0..1439, minutes since local
 *  midnight) falls into. Precedence: night (wraps midnight) → peak →
 *  offpeak default. */
export function clockToBucket(localMin: number, profile: TodProfile): TodBucket {
  const min = ((Math.floor(localMin) % 1440) + 1440) % 1440;
  const nFrom = hhmmToMin(profile.night_window.from);
  const nTo = hhmmToMin(profile.night_window.to);
  // Night window may wrap midnight (from > to). Two-segment check.
  const inNight = nFrom > nTo
    ? min >= nFrom || min < nTo
    : min >= nFrom && min < nTo;
  if (inNight) return 'night';
  for (const w of profile.peak_windows) {
    const f = hhmmToMin(w.from);
    const t = hhmmToMin(w.to);
    if (min >= f && min < t) return 'peak';
  }
  return 'offpeak';
}

function hhmmToMin(s: string): number {
  const parts = s.split(':').map(Number);
  return (parts[0] ?? 0) * 60 + (parts[1] ?? 0);
}
