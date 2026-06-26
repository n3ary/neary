/*
 * refreshBus — tiny reactive counter that pages subscribe to so the
 * shared header refresh button can trigger a re-fetch on whichever
 * route is currently active.
 *
 * Pattern:
 *   - The page's data-loading effect reads `refreshBus.tick` so it gets
 *     re-fired whenever the value changes.
 *   - The +layout binds Header's `onrefresh` to `refreshBus.fire()`.
 *
 * No per-page registration, no event listener cleanup — Svelte tracks
 * the read automatically.
 */

class RefreshBus {
  /** Monotonic tick. Pages that want to participate in manual refresh
   *  should reference this inside their data-loading effect. */
  tick = $state(0);

  fire(): void {
    this.tick += 1;
  }
}

export const refreshBus = new RefreshBus();
