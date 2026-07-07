/*
 * enableLocationPromptDismissedStore - sticky "dismissed" flag for the
 * first-time "Enable location" prompt on the home page. Once the user
 * dismisses it, the prompt stays hidden across reloads. The flag does
 * NOT reset on fresh opt-in (unlike noLocationCardDismissedStore):
 * once the user has dismissed the prompt, they've shown they know
 * about location, and we don't want to nag them after they later
 * disable location again from Settings.
 *
 * Persistence: localStorage key `neary:enableLocationPromptDismissed`,
 * stored as the literal string '1'. SSR-safe (no-ops on the server).
 */

const STORAGE_KEY = 'neary:enableLocationPromptDismissed';

function loadInitial(): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

class EnableLocationPromptDismissedStore {
  #dismissed = $state(loadInitial());

  /** Reactive read; the prompt hides itself when this is true. */
  get dismissed(): boolean {
    return this.#dismissed;
  }

  dismiss(): void {
    this.#dismissed = true;
    try {
      localStorage.setItem(STORAGE_KEY, '1');
    } catch {
      // Quota / disabled - silently noop. UI state already reflects dismissal.
    }
  }
}

export const enableLocationPromptDismissedStore = new EnableLocationPromptDismissedStore();