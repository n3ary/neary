/*
 * Main-thread facade for the GTFS worker. Components import `gtfsRepo` from
 * here — never the worker file directly. Keeps Comlink + worker plumbing
 * outside of UI code.
 *
 * Lazy: the worker isn't constructed until the first repo access, so the
 * SQLite-WASM payload (~1.5MB) doesn't load on routes that don't use it.
 */

import * as Comlink from 'comlink';
import type { GtfsRepo } from './types';

// In production both refs are simple module-scope singletons. In dev we
// restore them from `import.meta.hot.data` whenever this module is
// hot-replaced, so the worker (and its OPFS-SAH handles, and the bound
// SQLite DB) survives the reload. Without this, every save in the
// editor that touches this module's dependency graph would orphan the
// worker and trigger a full feed re-seed (~21 MB download + import).
let cached: Comlink.Remote<GtfsRepo> | null =
  (import.meta.hot?.data.cached as Comlink.Remote<GtfsRepo> | undefined) ?? null;
let workerInstance: Worker | null =
  (import.meta.hot?.data.workerInstance as Worker | undefined) ?? null;

export function getGtfsRepo(): Comlink.Remote<GtfsRepo> {
  if (cached) return cached;
  // Vite handles ?worker — produces a Worker class constructed below.
  // The dynamic import keeps the worker module out of the main-route bundle.
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  workerInstance = new Worker(new URL('../../workers/gtfs.worker.ts', import.meta.url), {
    type: 'module',
  });
  cached = Comlink.wrap<GtfsRepo>(workerInstance);
  return cached;
}

/** Suspend the GTFS worker for a backgrounding page — WITHOUT spawning
 *  it if it was never started (routes that never touched the repo
 *  must not pay the worker boot just to be told to sleep). */
export async function suspendGtfs(): Promise<void> {
  if (!cached) return;
  await cached.suspend();
}

if (import.meta.hot) {
  // Self-accept so Vite doesn't escalate updates here to a full page
  // reload (which would force the feed-bind cold path).
  import.meta.hot.accept();
  // Hand the worker + Comlink wrapper to the next module instance so the
  // restored values above pick them back up. Production untouched —
  // `import.meta.hot` is undefined there.
  import.meta.hot.dispose((data) => {
    data.workerInstance = workerInstance;
    data.cached = cached;
  });
}
