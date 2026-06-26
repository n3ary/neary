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
  /** Show schedule-only vehicles (kind: 'predicted' or 'scheduled') in
   *  station boards and maps. Pre-rename name was `showGhostVehicles`;
   *  legacy values auto-migrate on read. */
  showScheduleOnlyVehicles = $state(true);
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
        showScheduleOnlyVehicles: boolean;
        /** Legacy key, migrated to showScheduleOnlyVehicles. */
        showGhostVehicles: boolean;
        apiKey: string | null;
      }>;
      if (o.theme === 'auto' || o.theme === 'light' || o.theme === 'dark') this.theme = o.theme;
      if (typeof o.feedId === 'string' || o.feedId === null) this.feedId = o.feedId;
      if (typeof o.showDropOffOnly === 'boolean') this.showDropOffOnly = o.showDropOffOnly;
      if (typeof o.showScheduleOnlyVehicles === 'boolean') {
        this.showScheduleOnlyVehicles = o.showScheduleOnlyVehicles;
      } else if (typeof o.showGhostVehicles === 'boolean') {
        this.showScheduleOnlyVehicles = o.showGhostVehicles;
      }
      if (typeof o.apiKey === 'string' || o.apiKey === null) this.apiKey = o.apiKey;
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
      showScheduleOnlyVehicles: this.showScheduleOnlyVehicles,
      apiKey: this.apiKey,
    };
  }
}

export const userPrefs = new UserPrefs();
export const STORAGE_KEY_USER_PREFS = STORAGE_KEY;
