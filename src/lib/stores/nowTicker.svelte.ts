// Single-source reactive wall-clock for the UI. One timer, one $state field, every consumer reads. Cadence matches livePollMs; smoothness between ticks on the map comes from RAF interpolation, not a faster tick. `bump()` snaps every nowMin-derived value to the current wall clock — used by the manual refresh handler.

const TICK_MS = 15_000;

class NowTicker {
  ms = $state(Date.now());
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // SSR-safe: setInterval exists in node but the timer is harmless there and isn't observed.
    this.#timer = setInterval(() => (this.ms = Date.now()), TICK_MS);
  }

  // Reset timer phase so the next tick lands a fresh TICK_MS away (rather than mid-cycle).
  bump() {
    this.ms = Date.now();
    if (this.#timer != null) {
      clearInterval(this.#timer);
      this.#timer = setInterval(() => (this.ms = Date.now()), TICK_MS);
    }
  }
}

export const nowTicker = new NowTicker();
