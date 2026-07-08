// Tuning constants for the /favorites Stations tab pagination +
// ranking. One place so the page-size + prefetch threshold can be
// dialed without hunting through components.

/** Rows fetched per worker round-trip on the Stations tab. Picked
 *  to fit ~1.5 viewports on a phone-sized card; smaller means more
 *  round-trips, larger means the first paint waits too long on a
 *  national-scale feed. */
export const STATIONS_PAGE_SIZE = 40;

/** Sentinel-driven prefetch: when the IntersectionObserver reports
 *  the sentinel row is within this many viewports of the viewport
 *  bottom, fetch the next page. `rootMargin: '1000px 0px'` on the
 *  observer gets us ~1.5 viewports ahead at typical phone heights;
 *  the constant is the scalar the page multiplies by. Kept named
 *  (not inlined) so the prefetch distance can be tuned in one edit. */
export const STATIONS_PREFETCH_VIEWPORT_FACTOR = 1;

/** Pure helper: given the sentinel row's bottom edge (in viewport
 *  coordinates), the viewport height, and the prefetch factor,
 *  should the next page be requested?
 *
 *  `viewportBottom = window.innerHeight` (or whatever the page
 *  uses); `sentinelBottom = sentinelRow.getBoundingClientRect().bottom`.
 *  When `sentinelBottom <= viewportBottom + factor * viewportHeight`,
 *  prefetch — the sentinel has crossed within `factor` viewports of
 *  the viewport bottom. Extracted so the page logic is testable
 *  without a DOM. */
export function shouldPrefetchNextPage(args: {
  sentinelBottom: number;
  viewportHeight: number;
  factor?: number;
}): boolean {
  const f = args.factor ?? STATIONS_PREFETCH_VIEWPORT_FACTOR;
  if (args.viewportHeight <= 0) return false;
  return args.sentinelBottom <= args.viewportHeight + f * args.viewportHeight;
}