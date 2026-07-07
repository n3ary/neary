/*
 * createDismissedFlag - factory for sticky localStorage-backed "dismissed"
 * booleans. Centralises the SSR-safe loadInitial + set/clear pattern
 * that was previously duplicated across noLocationCardDismissedStore
 * and enableLocationPromptDismissedStore. Future "dismissed" flags
 * (e.g. a banner, a tutorial overlay) drop in as a one-line call.
 *
 * Usage:
 *
 *   export const fooDismissed = createDismissedFlag({
 *     storageKey: 'neary:fooDismissed',
 *   });
 *
 *   export const barDismissed = createDismissedFlag({
 *     storageKey: 'neary:barDismissed',
 *     // Auto-clear when this getter transitions false -> true
 *     // (e.g. a fresh opt-in resurfaces a previously-dismissed card).
 *     resetOn: () => userPrefs.someFlag,
 *   });
 *
 * The returned object exposes a reactive `dismissed` getter plus
 * `dismiss()` and (when `resetOn` is provided) `reset()`. Reads are
 * reactive - consumers can subscribe via the getter in derived/effect
 * contexts to react to dismissal transitions.
 */

export type DismissedFlag = {
  /** Reactive read; consumers subscribe by reading this getter. */
  readonly dismissed: boolean;
  /** Set the flag (writes to localStorage + updates reactive state). */
  dismiss(): void;
  /** Clear the flag (writes to localStorage + updates reactive state).
   *  Available regardless of `resetOn` so consumers can manually reset
   *  without the auto-reset effect firing. */
  reset(): void;
};

export type DismissedFlagOptions = {
  /** localStorage key, e.g. 'neary:fooDismissed'. */
  storageKey: string;
  /** When provided, the flag auto-clears on the false -> true edge of
   *  this getter. Useful for cards that should resurface after a
   *  specific user action (e.g. fresh opt-in for NoLocationCard). */
  resetOn?: () => boolean;
};

function loadInitial(storageKey: string): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    return localStorage.getItem(storageKey) === '1';
  } catch {
    return false;
  }
}

function writeDismissed(storageKey: string, dismissed: boolean): void {
  if (typeof localStorage === 'undefined') return;
  try {
    if (dismissed) {
      localStorage.setItem(storageKey, '1');
    } else {
      localStorage.removeItem(storageKey);
    }
  } catch {
    // Quota / disabled - silently noop. UI state already reflects the value.
  }
}

export function createDismissedFlag(opts: DismissedFlagOptions): DismissedFlag {
  let dismissed = $state(loadInitial(opts.storageKey));

  if (opts.resetOn) {
    // Track the previous value of the reset signal so we only act on
    // the false -> true edge (a fresh trigger). Running under
    // $effect.root because this factory may be called at module load,
    // outside any component scope.
    const resetOn = opts.resetOn;
    let prev = resetOn();
    $effect.root(() => {
      $effect(() => {
        const now = resetOn();
        if (now && !prev) {
          dismissed = false;
          writeDismissed(opts.storageKey, false);
        }
        prev = now;
      });
    });
  }

  return {
    get dismissed() {
      return dismissed;
    },
    dismiss() {
      dismissed = true;
      writeDismissed(opts.storageKey, true);
    },
    reset() {
      dismissed = false;
      writeDismissed(opts.storageKey, false);
    },
  };
}