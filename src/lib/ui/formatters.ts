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

/** Unix-ms → a human-friendly "when did this happen?" string.
 *  Picks the smallest representation that's still informative:
 *
 *    < 1 min        → 'just now'
 *    < 1 h          → '13 min ago'
 *    same calendar day      → 'today, 16:04'
 *    previous calendar day  → 'yesterday, 16:04'
 *    < 7 days       → 'Fri 16:04'
 *    same year      → '25 Jun'
 *    older          → '25 Jun 2025'
 *
 *  Past ~24 h the relative phrasing ("3 weeks ago") becomes less
 *  precise than the date itself, so this hands off rather than
 *  showing both. Time component is dropped once a date is shown
 *  because at that age sub-minute precision isn't useful.
 *  Uses `en-GB` locale to pin DD/MM-style ordering and month
 *  abbreviations across browsers. */
export function formatWhen(ms: number | null | undefined): string {
  if (ms == null) return '—';

  const now = new Date();
  const then = new Date(ms);
  const dt = Math.max(0, now.getTime() - ms);

  const min = Math.floor(dt / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;

  const startOfDay = (d: Date) => {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
  };
  const daysDiff = Math.round(
    (startOfDay(now).getTime() - startOfDay(then).getTime()) / 86_400_000,
  );

  const time = then.toLocaleString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });

  if (daysDiff === 0) return `today, ${time}`;
  if (daysDiff === 1) return `yesterday, ${time}`;
  if (daysDiff < 7) {
    const wd = then.toLocaleString('en-GB', { weekday: 'short' });
    return `${wd} ${time}`;
  }
  if (then.getFullYear() === now.getFullYear()) {
    return then.toLocaleString('en-GB', { day: 'numeric', month: 'short' });
  }
  return then.toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}
