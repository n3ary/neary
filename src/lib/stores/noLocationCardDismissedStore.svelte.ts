/*
 * noLocationCardDismissedStore - sticky "dismissed" flag for the
 * NoLocationCard. Persists in localStorage so a dismissed card stays
 * hidden across reloads. Consumers reset() the flag when the user
 * takes a fresh opt-in action (the policy for *when* to reset lives
 * in the consumer, not here, so each consumer can react to its own
 * signals).
 *
 * Persistence: localStorage key `neary:noLocationCardDismissed`,
 * stored as the literal string '1'. SSR-safe (no-ops on the server).
 */

const STORAGE_KEY = 'neary:noLocationCardDismissed';

function loadInitial(): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

class NoLocationCardDismissedStore {
  #dismissed = $state(loadInitial());

  /** Reactive read; the card hides itself when this is true. */
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

  reset(): void {
    this.#dismissed = false;
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
  }
}

export const noLocationCardDismissedStore = new NoLocationCardDismissedStore();