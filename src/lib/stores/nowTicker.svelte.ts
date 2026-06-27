/*
 * nowTicker — single-source reactive wall-clock for the UI.
 *
 * Bucketers and ETA renderers need to re-derive whenever "now" moves
 * far enough that a row should shift bucket or its ETA decrement.
 * Every consumer used to maintain its own setInterval which (a) wasted
 * a timer per page and (b) drifted in cadence — two pages on screen
 * during a route swap could refresh seconds apart.
 *
 * One singleton, one timer, one $state field every consumer reads.
 * Cadence matches the live-data poll cadence so predictor inputs change
 * in lock-step; smoothness between ticks on the map comes from RAF
 * interpolation, not from a faster tick.
 *
 * `bump()` is called by the manual refresh button so a user tap snaps
 * every nowMin-derived value to the current wall clock immediately
 * instead of waiting up to one full tick.
 */

const TICK_MS = 15_000;

class NowTicker {
  /** Unix ms wall clock. Reactive. */
  ms = $state(Date.now());
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // SSR-safe: setInterval exists in node but the timer is harmless
    // there and isn't observed.
    this.#timer = setInterval(() => (this.ms = Date.now()), TICK_MS);
  }

  /** Force `ms` to the current wall clock and reset the timer phase.
   *  Use from the manual refresh handler so the next tick is a fresh
   *  TICK_MS away rather than landing mid-cycle. */
  bump() {
    this.ms = Date.now();
    if (this.#timer != null) {
      clearInterval(this.#timer);
      this.#timer = setInterval(() => (this.ms = Date.now()), TICK_MS);
    }
  }
}

export const nowTicker = new NowTicker();
