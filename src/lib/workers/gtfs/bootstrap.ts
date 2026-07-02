/*
 * Feed bootstrap — OPFS pool setup + per-feed seeding + the live-pipe
 * teardown that has to fire on every feed switch.
 *
 * Public surface:
 *   getPool()       — lazy, idempotent OPFS-SAH pool installer
 *   bootstrap(feed) — seed-or-open + return a per-feed Database
 *   closeCurrent()  — drop the current db, shape cache, and live timer
 *
 * The `setFeed` orchestration (call closeCurrent → bootstrap → start
 * the live timer) lives in the worker's API surface, not here, so
 * this module stays free of cross-concern wiring.
 */

import sqlite3InitModule, {
  type Database,
  type Sqlite3Static,
} from '@sqlite.org/sqlite-wasm';

import type { Feed } from '$lib/data/feeds';
import { opfsFileFor, pruneStaleFeedFiles } from '../opfsFilenames';
import { shapeCache } from './shapeCache';
import { resetLiveSnapshot, stopLiveTimer } from './livePipeline';
import { state } from './state';

// ---------------------------------------------------------------------------
// Source URL resolution per feed.
//
// neary-gtfs publishes to Cloudflare R2 served via the custom domain
// gtfs.n3ary.com. Each feeds.json entry has `files.sqlite_gz` as a
// filename that embeds the first 12 hex chars of the gzipped-blob
// sha256, so the URL is content-addressed: a content change produces
// a new filename, and any cached copy at an old URL is by construction
// still correct for that URL. After first fetch the file lives in OPFS
// so we never re-download unless the hash changes.
// ---------------------------------------------------------------------------

const BINARIES_BASE = 'https://gtfs.n3ary.com';
const OPFS_POOL_NAME = 'neary-gtfs';

function seedUrlFor(feed: Feed): string {
  if (!feed.files.sqlite_gz) {
    throw new Error(`Feed "${feed.id}" has no sqlite_gz in feeds.json`);
  }
  return `${BINARIES_BASE}/${feed.files.sqlite_gz}`;
}

// ---------------------------------------------------------------------------
// Lazy + feed-aware OPFS-SAH pool. Pool is created once (it persists
// across feed switches — multiple feed files coexist in OPFS). The
// per-feed Database is opened by `bootstrap()` below.
// ---------------------------------------------------------------------------

let poolPromise: Promise<Awaited<ReturnType<Sqlite3Static['installOpfsSAHPoolVfs']>>> | null = null;

export async function getPool() {
  if (poolPromise) return poolPromise;
  poolPromise = (async () => {
    // The published type signature omits the init-options object, but
    // the runtime accepts it for redirecting SQLite's internal logging.
    const initFn = sqlite3InitModule as unknown as (opts: {
      print?: (msg: string) => void;
      printErr?: (msg: string) => void;
    }) => Promise<Sqlite3Static>;
    const sqlite3 = await initFn({
      print: (m: string) => console.log('[gtfs.worker:sqlite]', m),
      printErr: (m: string) => console.error('[gtfs.worker:sqlite]', m),
    });
    // OPFS access-handle pool. SAH is exclusive per-file across the
    // browser, so a stale handle from another tab or a not-yet-GC'd
    // worker can block init. `forceReinitIfPreviouslyFailed` lets a
    // retry attempt re-run init instead of replaying the cached
    // rejection. We also do one in-flight retry against transient
    // races (HMR worker swap, another tab still releasing).
    //
    // `verbosity: 0` silences the pool's own per-file 'storeErr'
    // logging. Those entries are one-per-blocked-slot during init
    // and the pool surfaces the failure as a thrown rejection
    // anyway — we already handle that here with retry + a
    // user-readable error, so the console noise is pure FUD.
    const opts = {
      name: OPFS_POOL_NAME,
      forceReinitIfPreviouslyFailed: true,
      verbosity: 0,
    } as const;
    try {
      return await sqlite3.installOpfsSAHPoolVfs(opts);
    } catch (firstErr) {
      console.warn('[gtfs.worker] OPFS pool init failed, retrying in 250ms…', firstErr);
      await new Promise((r) => setTimeout(r, 250));
      try {
        return await sqlite3.installOpfsSAHPoolVfs(opts);
      } catch (secondErr) {
        throw new Error(
          'Unable to open the offline schedule database. Another browser ' +
          'tab on this site is probably holding the file open — close other ' +
          'Neary tabs and reload. (Underlying: ' +
          (secondErr instanceof Error ? secondErr.message : String(secondErr)) +
          ')',
        );
      }
    }
  })().catch((e) => {
    // Drop the cached rejection so a later setFeed() can try again
    // (e.g. after the user has closed the conflicting tab and tapped
    // the agency picker to retry).
    poolPromise = null;
    throw e;
  });
  return poolPromise;
}

export async function bootstrap(feed: Feed): Promise<Database> {
  const poolUtil = await getPool();
  const opfsFile = opfsFileFor(feed);

  if (!poolUtil.getFileNames().includes(opfsFile)) {
    const url = seedUrlFor(feed);
    console.log(`[gtfs.worker] Seeding OPFS for feed ${feed.id} from`, url);
    const res = await fetch(url);
    if (!res.ok || !res.body) {
      throw new Error(`Seed download for feed "${feed.id}" failed (HTTP ${res.status})`);
    }
    // Magic-byte detection: some static servers (Vite's sirv during dev)
    // auto-decompress `.gz` responses; jsDelivr / GitHub raw do not.
    // Decompress only when the body still starts with the gzip header.
    let bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
      const stream = new Response(bytes).body!.pipeThrough(new DecompressionStream('gzip'));
      bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    }
    console.log(`[gtfs.worker] Importing ${bytes.byteLength} bytes into ${opfsFile}…`);
    poolUtil.importDb(opfsFile, bytes);
    // After a successful import, drop any older snapshot of THIS feed
    // so OPFS doesn't fill with one file per upstream rebuild.
    const removed = pruneStaleFeedFiles(poolUtil, feed.id, opfsFile);
    if (removed > 0) console.log(`[gtfs.worker] Pruned ${removed} stale OPFS file(s) for ${feed.id}`);
  }

  const db = new poolUtil.OpfsSAHPoolDb(opfsFile);
  db.exec('PRAGMA query_only = 1;');
  return db;
}

/** Close the currently-open DB, if any. The OPFS file stays put.
 *  Also clears feed-scoped caches and stops the live timer so a
 *  feed switch can't briefly broadcast stale vehicles. Listeners
 *  on the live pipeline are intentionally NOT cleared — they belong
 *  to the main-side store which survives feed switches. */
export function closeCurrent(): void {
  if (state.currentDb) {
    try {
      state.currentDb.close();
    } catch (e) {
      console.warn('[gtfs.worker] db.close() failed', e);
    }
    state.currentDb = null;
  }
  state.currentFeedTz = null;
  state.bootstrapping = null;
  // Shape polylines are feed-scoped — invalidate so the next feed
  // can't see stale entries from this one.
  shapeCache.clear();
  // Live-pipeline state is feed-scoped too: stop the timer and drop
  // the cached snapshot so the next feed doesn't briefly broadcast
  // stale vehicles.
  stopLiveTimer();
  resetLiveSnapshot();
}
