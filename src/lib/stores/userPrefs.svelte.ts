/*
 * userPrefs — the user's persistent preferences. Loaded once from localStorage
 * on construction, written by the +layout effect on every change.
 *
 * Class instance (not a function) so consumers can do `userPrefs.theme = 'dark'`
 * directly with full reactivity — the $state-annotated fields are tracked.
 *
 * SSR-safe: the constructor checks for localStorage before reading, so
 * prerender just uses DEFAULTS.
 */

const STORAGE_KEY = 'neary-user-prefs';

export type Theme = 'auto' | 'light' | 'dark';

class UserPrefs {
  theme = $state<Theme>('auto');
  /** Selected transit feed id, or null when the user hasn't chosen yet. */
  feedId = $state<string | null>(null);
  /** Show "Drop off only" indicators on station / vehicle cards. */
  showDropOffOnly = $state(true);
  /** Show vehicles that have already departed (within the 5 min recency
   *  window) on station boards. Map view always shows them. Defaults off:
   *  most users only care about what's still coming. */
  showDepartedVehicles = $state(false);
  /** Diagnostic master switch. When on:
   *   - `tripId · kind · dir` rendered on every vehicle card +
   *     map marker (so cross-view screenshots can be correlated).
   *   - `showOffRouteVehicles` reads true (off-route bucket surfaces
   *     on station boards — vehicles too far from the route shape to
   *     match a trip). Same toggle drives both because they're both
   *     "give me everything to debug a divergence". Default off;
   *     persisted. */
  showDebugIds = $state(false);

  /** Back-compat alias for the previous `showOffRouteVehicles` toggle.
   *  Now folded into `showDebugIds` — callers passing `userPrefs` as
   *  `BoardPrefs` (structurally typed) keep working without churn. */
  get showOffRouteVehicles(): boolean {
    return this.showDebugIds;
  }
  /** Per-context-bucket cap on the station board. Applies to the
   *  `incoming` / `drop-off` / `departed` sections; the now-group
   *  (`departing` / `at-station` / `arriving`) and `off-route`
   *  diagnostic are always uncapped. See `capStationBoard`. */
  stationBoardMaxRows = $state(3);
  /** User's optional Tranzy API key — when set, live data layer activates. */
  apiKey = $state<string | null>(null);

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
        apiKey: string | null;
        stationBoardMaxRows: number;
      }>;
      if (o.theme === 'auto' || o.theme === 'light' || o.theme === 'dark') this.theme = o.theme;
      if (typeof o.feedId === 'string' || o.feedId === null) this.feedId = o.feedId;
      if (typeof o.showDropOffOnly === 'boolean') this.showDropOffOnly = o.showDropOffOnly;
      if (typeof o.showDepartedVehicles === 'boolean') this.showDepartedVehicles = o.showDepartedVehicles;
      if (typeof o.showOffRouteVehicles === 'boolean' && o.showOffRouteVehicles) this.showDebugIds = true;
      if (typeof o.showDebugIds === 'boolean') this.showDebugIds = o.showDebugIds;
      if (typeof o.apiKey === 'string' || o.apiKey === null) this.apiKey = o.apiKey;
      if (typeof o.stationBoardMaxRows === 'number' && o.stationBoardMaxRows > 0) this.stationBoardMaxRows = o.stationBoardMaxRows;
    } catch {
      // Corrupt or unreadable storage — fall back to defaults silently.
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
      apiKey: this.apiKey,
      stationBoardMaxRows: this.stationBoardMaxRows,
    };
  }
}

export const userPrefs = new UserPrefs();
export const STORAGE_KEY_USER_PREFS = STORAGE_KEY;
