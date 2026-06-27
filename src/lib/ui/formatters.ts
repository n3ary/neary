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
