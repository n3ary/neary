/*
 * locationStore — GPS state singleton consumed by the header's GPS dot and
 * (eventually, Phase 4) the Stations view's proximity query.
 *
 * Lifecycle:
 *   - Constructed lazily on first reactive access (module-level $state is
 *     fine in browser; SSR builds skip the watchPosition call because no
 *     consumer touches it during prerender).
 *   - `start()` is idempotent — the Stations route calls it on mount; later
 *     navigations to other views keep the watch alive so we don't lose
 *     position lock between tab switches.
 *   - A 15s ticker bumps `now`, so the `freshness` getter naturally demotes
 *     ok -> stale -> error over time without us having to remember to
 *     re-render.
 */

export type FreshState = 'idle' | 'ok' | 'stale' | 'error';
export type PermissionState = 'unknown' | 'prompt' | 'granted' | 'denied';

class LocationStore {
  position = $state<GeolocationPosition | null>(null);
  error = $state<GeolocationPositionError | null>(null);
  permission = $state<PermissionState>('unknown');
  lastUpdated = $state<number | null>(null);

  /** Ticks every 15s while a watch is active so `freshness` re-evaluates. */
  now = $state(typeof Date === 'undefined' ? 0 : Date.now());

  private watchId: number | null = null;
  private tickerId: ReturnType<typeof setInterval> | null = null;

  constructor() {
    if (typeof navigator === 'undefined' || !('permissions' in navigator)) return;
    // Permissions API is a hint — some browsers throw for geolocation.
    navigator.permissions
      .query({ name: 'geolocation' as PermissionName })
      .then((status) => {
        this.permission = status.state as PermissionState;
        status.addEventListener('change', () => {
          this.permission = status.state as PermissionState;
        });
      })
      .catch(() => {
        // Older browser or query unsupported — leave as 'unknown'.
      });
  }

  /** Idempotent. Returns true if a watch is active after the call. */
  start(): boolean {
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) return false;
    if (this.watchId !== null) return true;

    this.watchId = navigator.geolocation.watchPosition(
      (pos) => {
        this.position = pos;
        this.lastUpdated = Date.now();
        this.error = null;
      },
      (err) => {
        this.error = err;
        if (err.code === err.PERMISSION_DENIED) this.permission = 'denied';
      },
      // Low-accuracy is fine for proximity filtering and saves battery on iOS.
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 30_000 },
    );

    if (this.tickerId === null && typeof setInterval !== 'undefined') {
      this.tickerId = setInterval(() => (this.now = Date.now()), 15_000);
    }
    return true;
  }

  stop(): void {
    if (this.watchId !== null && typeof navigator !== 'undefined') {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
    if (this.tickerId !== null) {
      clearInterval(this.tickerId);
      this.tickerId = null;
    }
  }

  /**
   * Header-dot state. Buckets:
   *   - permission denied: error (red)
   *   - watch error w/ no position ever: error
   *   - no position yet: idle (grey)
   *   - position < 60s old: ok (green)
   *   - position 60s-5min old: stale (amber)
   *   - position older: error (red — likely lost signal)
   */
  get freshness(): FreshState {
    if (this.permission === 'denied') return 'error';
    if (this.error && !this.position) return 'error';
    if (!this.lastUpdated) return 'idle';
    const age = this.now - this.lastUpdated;
    if (age < 60_000) return 'ok';
    if (age < 5 * 60_000) return 'stale';
    return 'error';
  }

  /** Human-readable tooltip text for the dot. */
  get tooltip(): string {
    if (this.permission === 'denied') return 'Location permission denied';
    if (this.error && !this.position) return `GPS error: ${this.error.message}`;
    if (!this.lastUpdated) return 'Waiting for first GPS fix…';
    const ageSec = Math.round((this.now - this.lastUpdated) / 1000);
    if (ageSec < 60) return `GPS fresh (${ageSec}s ago)`;
    return `GPS last fix ${Math.round(ageSec / 60)} min ago`;
  }
}

export const locationStore = new LocationStore();
