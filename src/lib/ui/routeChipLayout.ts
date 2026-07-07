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
 * badge's actual CSS is `h-6 min-w-6 px-1.5 text-xs font-bold
 * rounded-md` (RouteBadge.svelte, size='small'). At 12px / 700
 * weight each character is ~9px wide -- a 3-char badge like
 * "54N" measures ~39px (12px padding + 27px text), not the
 * 33px a 7px/char estimate would give. The natural fit under-
 * estimates 3-char badges by enough that the last visible badge
 * gets clipped on tight cards. 9px/char + 12px padding fixes it.
 * Min wins at 24px for 1-char badges.
 */
export function badgeWidth(text: string): number {
  return Math.max(24, text.length * 9 + 12);
}

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

/**
 * Visible cap on badges. By default the natural fit is the cap: a
 * "+N" chip appears only when the catalogue genuinely overflows.
 * This way the chip row fills the available space -- a stop with
 * 18 serving routes on a 580px card shows 13 + "+5" (~97% fill),
 * not 10 + "+8" (~43% fill) under an arbitrary static cap.
 *
 * Callers can still override via the `maxVisible` prop for layouts
 * that need a hard upper bound (e.g. a dense summary view).
 */
export function comfortableCap(naturalVisible: number): number {
  return naturalVisible;
}
