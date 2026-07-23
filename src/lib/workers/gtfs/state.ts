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
  /** URL the live pipeline polls for cleaned GTFS-RT vehicle_positions.
   *  Comes from `feed.realtime.vehicle_positions` -- in production this
   *  is the canonical gtfs-rt.n3ary.com proxy URL (the static pipeline
   *  rewrites it when the feed has a per-feed config). null when the
   *  feed has no realtime configured. */
  currentFeedRtUrl: string | null = null;
  currentDb: Database | null = null;
  /** Dwell seconds per stop from the feed's _neary_config timing block.
   *  Used by assembleLiveBoards to thread feed-specific dwell into ETA. */
  currentDwellSec: number = 20;
  /** True when the bound SQLite blob has a `frequencies` table.
   *  Set by `bootstrap()` via a `sqlite_master` PRAGMA probe. Cached
   *  blobs that pre-date gtfs-publisher#252 (the DDL addition) report
   *  false; per-time query modules gate the frequency-expansion path
   *  on this so the app degrades to schedule-only behaviour without
   *  throwing on older blobs. */
  currentFeedHasFrequencies: boolean = false;
  /** Promise of the in-flight bootstrap when setFeed is mid-fetch.
   *  Used by ensureDb so the very first call can await the bind. */
  bootstrapping: Promise<Database> | null = null;
  /** AbortController wrapping the seed download currently being streamed
   *  by bootstrap(). `closeCurrent()` calls abort() on it so a feed
   *  switch mid-download stops the old fetch instead of running it to
   *  completion. Cleared once bootstrap succeeds (or fails). */
  currentDownloadAbort: AbortController | null = null;
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
