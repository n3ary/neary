// GPS singleton for the header dot and Stations proximity query. Lazy: watchPosition only starts on `start()` (idempotent) or `enable()`. Cadence (poll, watch maxAge, ticker) all come from NearyConfig.

import { userPrefs } from '../userPrefs.svelte';
import { DEFAULT_CONFIG } from '$lib/domain/config';

export type FreshState = 'off' | 'idle' | 'ok' | 'stale' | 'error';
export type PermissionState = 'unknown' | 'prompt' | 'granted' | 'denied';

const GPS_POLL_MS = DEFAULT_CONFIG.gpsPollMs;
const GPS_TIMEOUT_MS = GPS_POLL_MS;
const GPS_MAX_AGE_MS = GPS_POLL_MS;

// Per W3C, `timestamp` is ms. Some iOS Safari WebKit builds report seconds; pick whichever candidate lands closer to `now`.
function normalizePositionTimestamp(raw: number, now: number): number {
  if (raw <= 0) return raw;
  const distanceIfAlreadyMs = Math.abs(now - raw);
  const distanceIfWasSeconds = Math.abs(now - raw * 1000);
  return distanceIfAlreadyMs <= distanceIfWasSeconds ? raw : raw * 1000;
}

// Prefers the fix's own timestamp so a cached fix reads as stale. Falls back to `now` when the timestamp is implausibly far off — Safari desktop WiFi-derived fixes have been seen returning years-old timestamps even after unit normalization.
function plausibleLastUpdated(raw: number, now: number): number {
  const normalized = normalizePositionTimestamp(raw, now);
  const ageMs = Math.abs(now - normalized);
  return ageMs <= 86_400_000 ? normalized : now;
}

class LocationStore {
  position = $state<GeolocationPosition | null>(null);
  error = $state<GeolocationPositionError | null>(null);
  permission = $state<PermissionState>('unknown');
  lastUpdated = $state<number | null>(null);
  /** Bumps every GPS_POLL_MS while watching so `freshness` re-evaluates without manual re-render. */
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
        // Older browser / query unsupported — leave as 'unknown'.
      });
  }

  /** Idempotent. Returns true if a watch is active after the call. */
  start(): boolean {
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) return false;
    if (this.watchId !== null) return true;

    this.watchId = navigator.geolocation.watchPosition(
      (pos) => {
        this.position = pos;
        // Use the fix's timestamp, not Date.now() — Date.now() would pin the dot green even when the cached fix is older than the callback time (cached / OS-delayed delivery).
        this.lastUpdated = plausibleLastUpdated(pos.timestamp, Date.now());
        this.error = null;
        // Safari iOS doesn't fire Permissions API change events for geolocation, so a successful fix is the only reliable permission grant signal.
        this.permission = 'granted';
      },
      (err) => {
        this.error = err;
        if (err.code === err.PERMISSION_DENIED) {
          this.permission = 'denied';
          // Don't revert userPrefs.gpsOptedIn: home + settings derive their denied state from gpsState+permission. Reverting would strand them in "not opted in" while permission is still denied. Browser remembers the denial; future enable() re-prompts only after browser-settings clear.
          this.stop();
        }
      },
      // enableHighAccuracy:false saves battery on iOS. maxAge = poll cadence so a stalled watch can't return a fix older than one poll cycle.
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: GPS_MAX_AGE_MS },
    );

    if (this.tickerId === null && typeof setInterval !== 'undefined') {
      this.tickerId = setInterval(() => (this.now = Date.now()), 15_000);
    }
    return true;
  }

  /** Mark the user opted in (persists) and start the watch. Idempotent. The "engaged with GPS at least once" flag stays true across opt-outs. */
  enable(): boolean {
    userPrefs.gpsOptedIn = true;
    userPrefs.hasEverEnabledGPS = true;
    return this.start();
  }

  /** Explicit opt-out: clear the persistent flag, stop the watch, drop cached position. Browser's own permission record is untouched. */
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
    this.stopPolling();
  }

  /** Per-view GPS polling. Starts a GPS_POLL_MS getCurrentPosition loop so a stalled watch (iOS Safari with enableHighAccuracy:false) can't leave the UI anchored to a stale fix. Watch stays alive underneath. Idempotent. */
  startPolling(): void {
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) return;
    if (this.pollId !== null) return;
    const opts = { enableHighAccuracy: false, maximumAge: GPS_MAX_AGE_MS, timeout: GPS_TIMEOUT_MS };
    this.pollOnce(opts);
    this.pollId = setInterval(() => this.pollOnce(opts), GPS_TIMEOUT_MS);
  }

  /** Counterpart to startPolling. Idempotent. */
  stopPolling(): void {
    if (this.pollId !== null) {
      clearInterval(this.pollId);
      this.pollId = null;
    }
  }

  /** One-shot high-accuracy fix bypassing the OS cache. Powers the "Position me" FAB on Stations. */
  forceFreshFix(): void {
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) return;
    this.pollOnce({ enableHighAccuracy: true, maximumAge: 0, timeout: GPS_TIMEOUT_MS });
  }

  private pollOnce(opts: PositionOptions): void {
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        this.position = pos;
        this.lastUpdated = plausibleLastUpdated(pos.timestamp, Date.now());
        this.error = null;
      },
      // Polling failures are non-fatal: the underlying watch is still running. Surfacing them would flap the dot on a flaky connection.
      () => { /* swallow */ },
      opts,
    );
  }

  /** Debug: pin the store to a fake lat/lon bypassing geolocation. Exposed on window as `neary.setLocation(lat, lon)` for browsers without a built-in GPS override (Safari). */
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

  clearMockPosition(): void {
    this.position = null;
    this.lastUpdated = null;
  }

  /** True iff a watch is active. Distinguishes 'view never asked' (no tooltip) from 'view asked, waiting for first fix' (legitimate 'waiting'). */
  get isWatching(): boolean {
    return this.watchId !== null;
  }

  /** True iff the browser exposes a geolocation API. SSR-safe (false on server). */
  get isSupported(): boolean {
    return typeof navigator !== 'undefined' && 'geolocation' in navigator;
  }

  // Header-dot state. A returning user with previously-denied permission doesn't see an alarming red dot before they've attempted Enable — the gate is "opted in + denied OR error".
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

  /** Human-readable dot tooltip. */
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
