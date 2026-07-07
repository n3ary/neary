/*
 * noLocationCardDismissedStore - sticky "dismissed" flag for the
 * NoLocationCard. Persists in localStorage so a dismissed card stays
 * hidden across reloads.
 *
 * The store also watches userPrefs.gpsOptedIn for a false -> true
 * transition (a fresh opt-in) and resets the dismissal automatically.
 * Centralising the reset here means every NoLocationCard consumer
 * (home + settings today, plus future ones) gets the right behavior
 * without duplicating the watcher.
 *
 * Persistence: localStorage key `neary:noLocationCardDismissed`,
 * stored as the literal string '1'. SSR-safe (no-ops on the server).
 */

import { userPrefs } from './userPrefs.svelte';

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

  constructor() {
    // Detect a fresh opt-in (false -> true) and reset the dismissal
    // so the card reappears if the next permission attempt fails.
    // Running under $effect.root because this singleton is
    // instantiated at module load, outside any component scope.
    let prevOptedIn = userPrefs.gpsOptedIn;
    $effect.root(() => {
      $effect(() => {
        const isOptedIn = userPrefs.gpsOptedIn;
        if (isOptedIn && !prevOptedIn) {
          this.#dismissed = false;
          try {
            localStorage.removeItem(STORAGE_KEY);
          } catch {
            // ignore
          }
        }
        prevOptedIn = isOptedIn;
      });
    });
  }

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