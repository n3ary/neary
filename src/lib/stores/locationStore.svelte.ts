/*
 * locationStore — GPS state singleton consumed by the header's GPS dot and
 * the Stations view's proximity query.
 *
 * Lifecycle:
 *   - Constructed lazily on first reactive access (browser only; SSR builds
 *     skip the watchPosition call because no consumer touches it during
 *     prerender).
 *   - GPS is strictly opt-in. `start()` is idempotent but does not flip the
 *     "opted in" flag; callers that want the user choice to persist across
 *     reloads use `enable()` instead. The +layout effect calls `start()`
 *     on mount when `userPrefs.gpsOptedIn` is already true.
 *   - A 15s ticker bumps `now`, so the `freshness` getter naturally demotes
 *     ok -> stale -> error over time without us having to remember to
 *     re-render.
 */

import { userPrefs } from './userPrefs.svelte';
import { DEFAULT_CONFIG } from '$lib/domain/config';

export type FreshState = 'off' | 'idle' | 'ok' | 'stale' | 'error';
export type PermissionState = 'unknown' | 'prompt' | 'granted' | 'denied';

/** Watch + polling cache window + timeouts, all sourced from
 *  NearyConfig. Pulled at module load so the polling keeps its cadence
 *  even if config tuning gets wired into Settings later (issue #206). */
const GPS_POLL_MS = DEFAULT_CONFIG.gpsPollMs;
const GPS_TIMEOUT_MS = GPS_POLL_MS;
const GPS_MAX_AGE_MS = GPS_POLL_MS;

class LocationStore {
  position = $state<GeolocationPosition | null>(null);
  error = $state<GeolocationPositionError | null>(null);
  permission = $state<PermissionState>('unknown');
  lastUpdated = $state<number | null>(null);

  /** Ticks every 15s while a watch is active so `freshness` re-evaluates. */
  now = $state(typeof Date === 'undefined' ? 0 : Date.now());

  private watchId: number | null = null;
  private tickerId: ReturnType<typeof setInterval> | null = null;
  private pollId: ReturnType<typeof setInterval> | null = null;

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
        // Use the fix's own timestamp, NOT Date.now(). Date.now() would
        // disagree with the freshness check the moment a fix is older
        // than the callback time (cached / OS-delayed), pinning the dot
        // green while the rest of the UI races a stale position. See #206.
        this.lastUpdated = pos.timestamp;
        this.error = null;
        // Reflect the actual browser state. navigator.permissions on
        // Safari iOS doesn't fire change events for geolocation, so
        // `permission` can be stuck at 'denied' from a previous denial
        // even after the user grants via the prompt. A successful fix
        // is the only reliable signal that permission is now 'granted'
        // - update it here so Settings' denied gate (which reads
        // permission directly) doesn't keep showing the NoLocationCard
        // while Stations already sees nearby stops.
        this.permission = 'granted';
      },
      (err) => {
        this.error = err;
        if (err.code === err.PERMISSION_DENIED) {
          this.permission = 'denied';
          // Don't revert userPrefs.gpsOptedIn here: the rest of the
          // app reacts to the denied state via locationStore.permission
          // and the home / settings derive `denied` from gpsState +
          // permission. Reverting would strand the user in a "not-
          // opted-in" semantics state while permission is still
          // 'denied', which breaks the home-page denied stack and the
          // auto-resume effect in +layout. The browser remembers the
          // denial; subsequent enable() calls re-prompt only after the
          // user clears it in browser settings.
          this.stop();
        }
      },
      // Low-accuracy is fine for proximity filtering and saves battery
      // on iOS. maxAge matches the polling cadence (15s) so a stalled
      // watch cannot return a fix older than one poll cycle. See #206.
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: GPS_MAX_AGE_MS },
    );

    if (this.tickerId === null && typeof setInterval !== 'undefined') {
      this.tickerId = setInterval(() => (this.now = Date.now()), 15_000);
    }
    return true;
  }

  /**
   * Mark the user as opted in (persists across reloads via userPrefs) and
   * start the watch. Single entry point for the in-page "Enable location"
   * button and the header's GPS-off dot — they both call this. Idempotent:
   * safe to call repeatedly.
   */
  enable(): boolean {
    userPrefs.gpsOptedIn = true;
    // Record that the user has engaged with GPS at least once. Stays
    // true even if they later disable from Settings or the browser
    // prompt denied - in either case they've shown they know about
    // location, so the first-time "Enable location" home-page prompt
    // shouldn't reappear.
    userPrefs.hasEverEnabledGPS = true;
    return this.start();
  }

  /**
   * Explicit opt-out: clear the persistent flag, stop the watch, and
   * drop any cached position. Called from the Settings "Use location"
   * toggle so the user can revoke without having to wait for the next
   * browser prompt and decline it. The browser's own permission record
   * is untouched (only the OS / browser UI can clear that).
   */
  disable(): void {
    userPrefs.gpsOptedIn = false;
    this.stop();
    this.position = null;
    this.error = null;
    this.lastUpdated = null;
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
    // Settings-driven opt-out also drops any active polling.
    this.stopPolling();
  }

  /**
   * Per-view GPS polling. Starts a 15 s getCurrentPosition loop so a
   * stalled watchPosition (documented iOS Safari behaviour for
   * enableHighAccuracy:false, see #206) cannot leave the UI anchored
   * to a stale fix. The underlying watchPosition is left alive — it
   * continues to feed fresh fixes when the OS feels like it, and keeps
   * the header dot honest on views that don't opt into polling (the
   * Stations view's own $effect calls startPolling on mount and
   * stopPolling on cleanup).
   *
   * Idempotent. Safe to call repeatedly.
   */
  startPolling(): void {
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) return;
    if (this.pollId !== null) return;
    // Kick an immediate first fix so the dot updates without waiting
    // one tick when the user lands on the Stations view.
    this.pollOnce({
      enableHighAccuracy: false,
      maximumAge: GPS_MAX_AGE_MS,
      timeout: GPS_TIMEOUT_MS,
    });
    this.pollId = setInterval(
      () => this.pollOnce({
        enableHighAccuracy: false,
        maximumAge: GPS_MAX_AGE_MS,
        timeout: GPS_TIMEOUT_MS,
      }),
      GPS_TIMEOUT_MS,
    );
  }

  /** Counterpart to startPolling. Idempotent. */
  stopPolling(): void {
    if (this.pollId !== null) {
      clearInterval(this.pollId);
      this.pollId = null;
    }
  }

  /**
   * One-shot high-accuracy fix, bypassing the OS cache. Powers the
   * "Position me" FAB on the Stations view — invoked when the cached
   * GPS is older than the user is willing to wait for. Boards are
   * still gated by stationsViewStore.shouldRefetchByPosition; this
   * just guarantees a fresh position, not a forced re-query.
   */
  forceFreshFix(): void {
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) return;
    this.pollOnce({
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: GPS_TIMEOUT_MS,
    });
  }

  private pollOnce(
    opts: PositionOptions,
  ): void {
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        this.position = pos;
        this.lastUpdated = pos.timestamp;
        this.error = null;
      },
      // Polling failures are non-fatal: the underlying watch is still
      // running and the header dot reflects whatever it produces.
      // Surfacing them as the next fix would cause the dot to flap
      // between fix and error on a flaky cellular connection.
      () => { /* swallow */ },
      opts,
    );
  }

  /**
   * Debug helper: pin the store to an arbitrary lat/lon, bypassing the
   * geolocation API. Useful in browsers without a built-in GPS override
   * (notably Safari). Exposed on window as `neary.setLocation(lat, lon)`
   * by the layout. Pair with `clearMockPosition()` to resume real GPS.
   */
  setMockPosition(lat: number, lon: number, accuracy = 25): void {
    this.position = {
      coords: {
        latitude: lat,
        longitude: lon,
        accuracy,
        altitude: null,
        altitudeAccuracy: null,
        heading: null,
        speed: null,
        toJSON() {
          return { latitude: lat, longitude: lon, accuracy };
        },
      },
      timestamp: Date.now(),
      toJSON() {
        return { coords: this.coords, timestamp: this.timestamp };
      },
    } as GeolocationPosition;
    this.lastUpdated = Date.now();
    this.error = null;
  }

  /** Clear the mocked position; subsequent `watchPosition` callbacks (if a
   *  watch is active) will resume populating it. */
  clearMockPosition(): void {
    this.position = null;
    this.lastUpdated = null;
  }

  /** True iff a navigator.geolocation watch is currently active. The
   *  tooltip getter uses this to distinguish 'view never asked for
   *  GPS' (idle, no message) from 'view asked, still waiting for the
   *  first fix' (the legitimate 'waiting' state). */
  get isWatching(): boolean {
    return this.watchId !== null;
  }

  /** True iff the browser exposes a geolocation API. Settings and the
   *  home page branch on this to avoid offering toggles / search
   *  affordances that can't work in unsupported browsers. SSR-safe
   *  (returns false on the server). */
  get isSupported(): boolean {
    return typeof navigator !== 'undefined' && 'geolocation' in navigator;
  }

  /**
   * Header-dot state. Buckets:
   *   - user hasn't opted in yet: off (grey), regardless of any stale
   *     browser permission record. The dot only goes red after an
   *     explicit Enable attempt, so a returning user with previously-
   *     denied permission doesn't see an alarming state on first open.
   *   - opted in + permission denied: error (red)
   *   - opted in + watch error w/ no position ever: error
   *   - opted in + watch started but no position yet: idle (grey,
   *     waiting)
   *   - position < 60s old: ok (green)
   *   - position 60s-5min old: stale (amber)
   *   - position older: error (red — likely lost signal)
   */
  get freshness(): FreshState {
    if (!userPrefs.gpsOptedIn) return 'off';
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
    if (!userPrefs.gpsOptedIn) return 'GPS off — tap to enable.';
    if (this.permission === 'denied') return 'Location permission denied';
    if (this.error && !this.position) return `GPS error: ${this.error.message}`;
    if (!this.lastUpdated) return 'Waiting for first GPS fix…';
    const ageSec = Math.round((this.now - this.lastUpdated) / 1000);
    if (ageSec < 60) return `GPS fresh (${ageSec}s ago)`;
    return `GPS last fix ${Math.round(ageSec / 60)} min ago`;
  }
}

export const locationStore = new LocationStore();
