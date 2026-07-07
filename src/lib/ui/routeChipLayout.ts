// Layout math for the route-chips row. Kept out of the component
// so the formula has one home, the constants have one docblock,
// and any future change to badge sizing or overflow-chip layout
// only edits this file. The component itself imports naturalFit
// and comfortableCap; it does not compute widths inline.

import type { Route } from '$lib/domain/types';

/** Tailwind `gap-1`. */
const GAP_PX = 4;

/**
 * Heuristic width of a RouteBadge for a given short_name. The
 * constants (24 min, 7 per char, 12 padding) come from the badge's
 * `h-6 min-w-6 px-1.5 text-xs` CSS -- verified against multi-feed
 * catalogues with short_names up to 5 chars. Used by naturalFit to
 * size each badge individually rather than averaging.
 */
export function badgeWidth(text: string): number {
  return Math.max(24, text.length * 7 + 12);
}

/**
 * Worst-case width of the "+N" overflow chip. "+9" is 26px, "+99"
 * is 33px. Using the worst case in the fit check keeps the answer
 * honest regardless of how many routes the +N collapses.
 */
const PLUS_N_WIDTH_PX = 33;

/**
 * Largest N such that N badges + a "+M" overflow chip fits
 * `rowWidth`. When all badges fit without an overflow chip,
 * visible = routes.length and hidden = 0.
 *
 * `rowWidth` is the chip row's measured `clientWidth`, which
 * already reflects whatever container the row renders in (e.g.
 * the middle column of a flex row, excluding any sibling like
 * a favorites heart). So the fit scales with the actual layout
 * without this function needing to know about the surrounding UI.
 */
export function naturalFit(
  routes: readonly Route[],
  rowWidth: number,
): { visible: number; hidden: number } {
  if (routes.length === 0 || rowWidth <= 0) {
    return { visible: 0, hidden: 0 };
  }
  // First: does the full row fit without a "+N" chip?
  let full = 0;
  for (let i = 0; i < routes.length; i++) {
    full += badgeWidth(routes[i].shortName) + (i > 0 ? GAP_PX : 0);
  }
  if (full <= rowWidth) {
    return { visible: routes.length, hidden: 0 };
  }
  // Otherwise: largest N such that N badges + "+M" fits. The
  // overflow chip's width grows with M's digit count, so it
  // is sized via badgeWidth('+N') rather than a fixed constant.
  for (let n = routes.length - 1; n >= 0; n--) {
    let width = 0;
    for (let i = 0; i < n; i++) {
      width += badgeWidth(routes[i].shortName) + (i > 0 ? GAP_PX : 0);
    }
    const hidden = routes.length - n;
    const chipWidth = badgeWidth(`+${hidden}`);
    width += (n > 0 ? GAP_PX : 0) + chipWidth;
    if (width <= rowWidth) {
      return { visible: n, hidden };
    }
  }
  return { visible: 0, hidden: routes.length };
}

/** Show this fraction of the natural fit. Below 1.0, wide cards
 *  still trigger "+N" instead of painting every badge. */
const COMFORT_RATIO = 0.7;
/** Lower clamp: narrow rows always collapse (keeps "+N" meaningful). */
const MIN_CAP = 2;
/** Upper clamp: wide rows never stretch past a summary-friendly count. */
const MAX_CAP = 10;

/**
 * Comfortable cap on visible badges, derived from the natural fit.
 * `floor(naturalFit * ratio)` keeps the row at a comfortable
 * density; the [MIN_CAP, MAX_CAP] clamp handles the edges --
 * narrow rows still show >= 2 badges + "+N", wide rows never
 * paint more than 10 + "+N" regardless of how many badges
 * actually fit. The caller can pass an explicit `maxVisible` to
 * override this for a particular layout.
 */
export function comfortableCap(naturalVisible: number): number {
  const cap = Math.floor(naturalVisible * COMFORT_RATIO);
  return Math.max(MIN_CAP, Math.min(MAX_CAP, cap));
}
