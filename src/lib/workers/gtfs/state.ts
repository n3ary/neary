/*
 * Worker state — the small set of mutable singletons every query
 * module reads. Kept in one place so feed-switch can reset them
 * atomically and so individual query files stay free of module-level
 * state.
 *
 * `bootstrap.ts` mutates these; everything else only reads.
 */

import type { Database } from '@sqlite.org/sqlite-wasm';

class WorkerState {
  currentFeedId: string | null = null;
  /** Hash (`feed.hash`) of the currently-bound feed. Used by `setFeed`
   *  to detect when the same feed id has a newer published build and
   *  re-bootstrap against the new OPFS file. */
  currentFeedHash: string | null = null;
  /** IANA timezone for the current feed (e.g. 'Europe/Bucharest').
   *  Required for every minute-since-midnight conversion the queries do. */
  currentFeedTz: string | null = null;
  currentDb: Database | null = null;
  /** Dwell seconds per stop from the feed's _neary_config timing block.
   *  Used by assembleLiveBoards to thread feed-specific dwell into ETA. */
  currentDwellSec: number = 20;
  /** Promise of the in-flight bootstrap when setFeed is mid-fetch.
   *  Used by ensureDb so the very first call can await the bind. */
  bootstrapping: Promise<Database> | null = null;
}

export const state = new WorkerState();

/** Wait for the worker's DB to be open and return it. Throws when
 *  no feed has been bound yet — every query must go through this so
 *  we never run SQL against a null handle. */
export async function ensureDb(): Promise<Database> {
  if (state.currentDb) return state.currentDb;
  if (state.bootstrapping) return state.bootstrapping;
  throw new Error('GTFS worker not bound to a feed yet — call setFeed(feed) first.');
}
