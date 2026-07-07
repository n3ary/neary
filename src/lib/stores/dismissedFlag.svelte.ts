// Sticky localStorage-backed "dismissed" boolean factory. SSR-safe load + write; `resetOn` auto-clears on the false→true edge of the supplied getter (e.g. fresh opt-in resurfaces a previously-dismissed card).

export type DismissedFlag = {
  /** Reactive read. */
  readonly dismissed: boolean;
  dismiss(): void;
  /** Always available regardless of `resetOn` so consumers can manually reset without firing the auto-reset effect. */
  reset(): void;
};

export type DismissedFlagOptions = {
  /** localStorage key, e.g. 'neary:fooDismissed'. */
  storageKey: string;
  /** When provided, the flag auto-clears on the false → true edge. */
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
    // Quota / disabled — silently noop. UI state already reflects the value.
  }
}

export function createDismissedFlag(opts: DismissedFlagOptions): DismissedFlag {
  let dismissed = $state(loadInitial(opts.storageKey));

  if (opts.resetOn) {
    // Track the previous value so we only act on the false → true edge. $effect.root because this factory may be called at module load, outside any component scope.
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
