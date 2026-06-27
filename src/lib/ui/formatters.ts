/**
 * Shared UI formatters. Keep these pure (no DOM, no stores, no locale
 * surprises beyond what the JS runtime already provides). Anything more
 * complex than this file should live in `src/lib/domain/` instead.
 */

/** Bytes → "X KB" / "Y MB" with sensible precision for UI labels.
 *  Returns an empty string for null / undefined / 0 so call sites can
 *  inline it conditionally without their own guards. */
export function formatBytes(n: number | null | undefined): string {
  if (!n) return '';
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Unix-ms → "just now" / "3 min ago" / "5 h ago" / "2 days ago".
 *  Returns an em-dash for null. Anchored to `Date.now()` at call time. */
export function formatRelative(ms: number | null | undefined): string {
  if (ms == null) return '—';
  const dt = Math.max(0, Date.now() - ms);
  const min = Math.floor(dt / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} h ago`;
  const day = Math.floor(hr / 24);
  return `${day} day${day === 1 ? '' : 's'} ago`;
}

/** Unix-ms → locale absolute timestamp in 24-hour format.
 *  Returns an empty string for null. `hourCycle: 'h23'` forces 0–23
 *  regardless of the user's locale defaulting to 12-hour. */
export function formatAbsolute(ms: number | null | undefined): string {
  if (ms == null) return '';
  return new Date(ms).toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
}
