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
 * Cadence is 30s by default (every 0.5 min) so a vehicle’s ETA never
 * lies by more than half a minute. Cadence is intentionally NOT in
 * NearyConfig — it’s an internal UI tick, not a transit-logic knob.
 */

const TICK_MS = 30_000;

class NowTicker {
  /** Unix ms wall clock. Reactive. */
  ms = $state(Date.now());
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // SSR-safe: setInterval exists in node but the timer is harmless
    // there and isn't observed.
    this.#timer = setInterval(() => (this.ms = Date.now()), TICK_MS);
  }
}

export const nowTicker = new NowTicker();
