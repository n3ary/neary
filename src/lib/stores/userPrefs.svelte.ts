// Persistent user preferences. Loaded once from localStorage on construction, written by the +layout effect on every change. Class instance so `userPrefs.theme = 'dark'` is reactive end-to-end. SSR-safe (constructor bails on localStorage undefined).

const STORAGE_KEY = 'neary-user-prefs';

export type Theme = 'auto' | 'light' | 'dark';

class UserPrefs {
  theme = $state<Theme>('auto');
  /** Selected transit feed id, null when the user hasn't chosen yet. */
  feedId = $state<string | null>(null);
  /** Show "Drop off only" indicators on station / vehicle cards. */
  showDropOffOnly = $state(true);
  /** Show vehicles that have already departed (within the 5 min recency window) on station boards. Map view always shows them. Default off. */
  showDepartedVehicles = $state(false);
  /** Diagnostic master switch — surfaces tripId on cards + the off-route bucket on station boards (both "show me everything to debug a divergence"). Default off. */
  showDebugIds = $state(false);

  /** Back-compat alias for the previous `showOffRouteVehicles` toggle — folded into `showDebugIds`. */
  get showOffRouteVehicles(): boolean {
    return this.showDebugIds;
  }
  /** Per-context-bucket cap; now-group + `off-route` are uncapped. See `capStationBoard`. */
  stationBoardMaxRows = $state(3);
  /** Has the user explicitly turned GPS on? Drives the Stations "location needed" card + the header GPS dot's `off` state. */
  gpsOptedIn = $state(false);
  /** True once the user has ever called `locationStore.enable()` — even if denied or later disabled. Used by home to suppress the first-time Enable CTA once the user has engaged. */
  hasEverEnabledGPS = $state(false);
  /** Unix-ms of the user's most recent route marker assignment. Drives
   *  the /favorites default tab - whichever kind was marked more
   *  recently wins when both have entries. Null = never. */
  lastRouteMarkedAt = $state<number | null>(null);
  /** Unix-ms of the user's most recent station marker assignment.
   *  See `lastRouteMarkedAt`. */
  lastStationMarkerAssignedAt = $state<number | null>(null);

  constructor() {
    if (typeof localStorage === 'undefined') return;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const o = JSON.parse(raw) as Partial<{
        theme: Theme;
        feedId: string | null;
        showDropOffOnly: boolean;
        showDepartedVehicles: boolean;
        showOffRouteVehicles: boolean;
        showDebugIds: boolean;
        stationBoardMaxRows: number;
        gpsOptedIn: boolean;
        hasEverEnabledGPS: boolean;
        lastRouteMarkedAt: number | null;
        lastStationMarkerAssignedAt: number | null;
      }>;
      if (o.theme === 'auto' || o.theme === 'light' || o.theme === 'dark') this.theme = o.theme;
      if (typeof o.feedId === 'string' || o.feedId === null) this.feedId = o.feedId;
      if (typeof o.showDropOffOnly === 'boolean') this.showDropOffOnly = o.showDropOffOnly;
      if (typeof o.showDepartedVehicles === 'boolean') this.showDepartedVehicles = o.showDepartedVehicles;
      if (typeof o.showOffRouteVehicles === 'boolean' && o.showOffRouteVehicles) this.showDebugIds = true;
      if (typeof o.showDebugIds === 'boolean') this.showDebugIds = o.showDebugIds;
      if (typeof o.stationBoardMaxRows === 'number' && o.stationBoardMaxRows > 0) this.stationBoardMaxRows = o.stationBoardMaxRows;
      if (typeof o.gpsOptedIn === 'boolean') this.gpsOptedIn = o.gpsOptedIn;
      if (typeof o.hasEverEnabledGPS === 'boolean') this.hasEverEnabledGPS = o.hasEverEnabledGPS;
      if (typeof o.lastRouteMarkedAt === 'number') this.lastRouteMarkedAt = o.lastRouteMarkedAt;
      if (typeof o.lastStationMarkerAssignedAt === 'number') this.lastStationMarkerAssignedAt = o.lastStationMarkerAssignedAt;
    } catch {
      // Corrupt/unreadable — defaults
    }
  }

  /** JSON-safe plain object snapshot for serialization. */
  snapshot() {
    return {
      theme: this.theme,
      feedId: this.feedId,
      showDropOffOnly: this.showDropOffOnly,
      showDepartedVehicles: this.showDepartedVehicles,
      showOffRouteVehicles: this.showDebugIds,
      showDebugIds: this.showDebugIds,
      stationBoardMaxRows: this.stationBoardMaxRows,
      gpsOptedIn: this.gpsOptedIn,
      hasEverEnabledGPS: this.hasEverEnabledGPS,
      lastRouteMarkedAt: this.lastRouteMarkedAt,
      lastStationMarkerAssignedAt: this.lastStationMarkerAssignedAt,
    };
  }
}

export const userPrefs = new UserPrefs();
export const STORAGE_KEY_USER_PREFS = STORAGE_KEY;
