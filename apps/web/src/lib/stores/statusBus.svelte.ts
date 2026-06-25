/*
 * statusBus — global reactive store backing the StatusBar primitive.
 *
 * Any module (worker boundary, view, service) can `statusBus.push(...)` an
 * entry; the StatusBar renders the highest-priority one. Loading and
 * progress entries are kept until explicitly removed; the rest auto-expire.
 *
 * Built on Svelte 5 runes — no library needed. Exported as a singleton via
 * a module-level `$state` rune, accessed by name (`statusBus`) elsewhere.
 *
 * Severity hierarchy (read by StatusBar):
 *   error > loading/progress > warning > info > success
 */

export type StatusKind = 'error' | 'loading' | 'progress' | 'warning' | 'info' | 'success';

export interface StatusEntry {
  /** Stable id used to update or dismiss the entry. */
  id: string;
  kind: StatusKind;
  message: string;
  /** 0-100. Only meaningful when `kind === 'progress'`. */
  progress?: number;
  /** Auto-dismiss after this many ms. Ignored for error / loading / progress. */
  ttlMs?: number;
}

const DEFAULT_TTL: Partial<Record<StatusKind, number>> = {
  success: 2500,
  info: 4000,
  warning: 6000,
};

function createStatusBus() {
  // Reactive array of active entries. The StatusBar reads this directly.
  let entries = $state<StatusEntry[]>([]);
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  function clearTimer(id: string) {
    const t = timers.get(id);
    if (t) {
      clearTimeout(t);
      timers.delete(id);
    }
  }

  function scheduleDismiss(entry: StatusEntry) {
    const ttl = entry.ttlMs ?? DEFAULT_TTL[entry.kind];
    if (typeof ttl === 'number' && ttl > 0) {
      clearTimer(entry.id);
      timers.set(
        entry.id,
        setTimeout(() => dismiss(entry.id), ttl),
      );
    }
  }

  /** Push or update an entry (matched by id). */
  function push(entry: StatusEntry): void {
    const existing = entries.findIndex((e) => e.id === entry.id);
    if (existing >= 0) {
      entries[existing] = entry;
    } else {
      entries.push(entry);
    }
    scheduleDismiss(entry);
  }

  /** Update progress on a `progress`-kind entry without re-pushing the message. */
  function progress(id: string, value: number): void {
    const idx = entries.findIndex((e) => e.id === id);
    if (idx >= 0 && entries[idx].kind === 'progress') {
      entries[idx] = { ...entries[idx], progress: value };
    }
  }

  function dismiss(id: string): void {
    clearTimer(id);
    entries = entries.filter((e) => e.id !== id);
  }

  function clear(): void {
    timers.forEach(clearTimeout);
    timers.clear();
    entries = [];
  }

  return {
    get entries() {
      return entries;
    },
    push,
    progress,
    dismiss,
    clear,
  };
}

export const statusBus = createStatusBus();
