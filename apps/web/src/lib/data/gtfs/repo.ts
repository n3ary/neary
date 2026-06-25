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

let cached: Comlink.Remote<GtfsRepo> | null = null;

export function getGtfsRepo(): Comlink.Remote<GtfsRepo> {
  if (cached) return cached;
  // Vite handles ?worker — produces a Worker class constructed below.
  // The dynamic import keeps the worker module out of the main-route bundle.
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const GtfsWorker = new Worker(new URL('../../workers/gtfs.worker.ts', import.meta.url), {
    type: 'module',
  });
  cached = Comlink.wrap<GtfsRepo>(GtfsWorker);
  return cached;
}
