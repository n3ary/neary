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

export async function bootstrap(
  feed: Feed,
  onProgress?: (bytesReceived: number, totalBytes: number | null) => void,
): Promise<Database> {
  const poolUtil = await getPool();
  const opfsFile = opfsFileFor(feed);

  if (!poolUtil.getFileNames().includes(opfsFile)) {
    const url = seedUrlFor(feed);
    console.log(`[gtfs.worker] Seeding OPFS for feed ${feed.id} from`, url);
    // 10-minute hard timeout: covers the ~122 MB Swiss feed on a slow
    // connection with headroom. Without this, a stalled fetch would
    // hang forever with no user-visible signal — precisely the class
    // of failure that made large feeds appear "silently empty".
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10 * 60_000);
    let res: Response;
    try {
      res = await fetch(url, { signal: controller.signal });
    } catch (e) {
      clearTimeout(timeoutId);
      const reason = controller.signal.aborted ? 'timed out' : 'network error';
      throw new Error(`Seed download for feed "${feed.id}" ${reason}: ${(e as Error).message}`);
    }
    if (!res.ok || !res.body) {
      clearTimeout(timeoutId);
      throw new Error(`Seed download for feed "${feed.id}" failed (HTTP ${res.status})`);
    }

    // Stream the body so we can report progress. Buffering to an
    // ArrayBuffer up front would still work but leaves the UI opaque
    // for the entire duration of a big feed (the Swiss 122 MB is the
    // reason this streams). Content-Length comes from R2's response;
    // fall back to null so downstream shows an indeterminate state.
    const totalHeader = res.headers.get('content-length');
    const totalBytes = totalHeader ? Number(totalHeader) : null;
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    let lastReportMs = 0;
    const REPORT_INTERVAL_MS = 250;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.byteLength;
        const now = performance.now();
        if (onProgress && now - lastReportMs >= REPORT_INTERVAL_MS) {
          try { onProgress(received, Number.isFinite(totalBytes) ? totalBytes : null); } catch {}
          lastReportMs = now;
        }
      }
    } catch (e) {
      clearTimeout(timeoutId);
      const reason = controller.signal.aborted ? 'timed out' : 'network error';
      throw new Error(`Seed download for feed "${feed.id}" ${reason} mid-stream: ${(e as Error).message}`);
    }
    clearTimeout(timeoutId);
    // Final progress tick so the UI reaches 100% before the (blocking)
    // decompress + import steps start.
    if (onProgress) {
      try { onProgress(received, Number.isFinite(totalBytes) ? totalBytes : null); } catch {}
    }

    // Concatenate the streamed chunks into a single Uint8Array for
    // DecompressionStream + importDb. Memory-equivalent to the old
    // arrayBuffer() path; the stream is just about UI feedback.
    let bytes = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    chunks.length = 0; // free the array of chunk refs eagerly

    // Magic-byte detection: some static servers (Vite's sirv during dev)
    // auto-decompress `.gz` responses; Cloudflare R2 does not.
    // Decompress only when the body still starts with the gzip header.
    if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
      const stream = new Response(bytes).body!.pipeThrough(new DecompressionStream('gzip'));
      bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    }
    console.log(`[gtfs.worker] Importing ${bytes.byteLength} bytes into ${opfsFile}…`);
    try {
      poolUtil.importDb(opfsFile, bytes);
    } catch (e) {
      // Best-effort cleanup: leave nothing partial in OPFS so a retry
      // isn't blocked by a corrupt file that seems to already exist.
      try { poolUtil.unlink(opfsFile); } catch {}
      throw new Error(`Import into OPFS failed for feed "${feed.id}": ${(e as Error).message}`);
    }
    // After a successful import, drop any older snapshot of THIS feed
    // so OPFS doesn't fill with one file per upstream rebuild.
    const removed = pruneStaleFeedFiles(poolUtil, feed.id, opfsFile);
    if (removed > 0) console.log(`[gtfs.worker] Pruned ${removed} stale OPFS file(s) for ${feed.id}`);
  }

  let db: Database | undefined;
  try {
    db = new poolUtil.OpfsSAHPoolDb(opfsFile);
    db.exec('PRAGMA query_only = 1;');
    // Integrity check: a truncated or empty file may open cleanly but
    // return zero rows, presenting as "search shows no results". If
    // the schedule table is empty, treat as corrupt and force a
    // re-download on the next attempt.
    const hasTable = db.selectValue('SELECT count(*) FROM sqlite_master WHERE type=\'table\' AND name=\'stop_times\'') as number | null;
    if (hasTable !== 1) {
      throw new Error('sqlite is missing the stop_times table (schema mismatch or truncated import)');
    }
    const hasRows = db.selectValue('SELECT EXISTS(SELECT 1 FROM stop_times LIMIT 1)') as 0 | 1;
    if (!hasRows) {
      throw new Error('stop_times is empty (truncated import or upstream produced an empty feed)');
    }
  } catch (e) {
    try { db?.close(); } catch {}
    try { poolUtil.unlink(opfsFile); } catch {}
    throw new Error(`Feed "${feed.id}" failed integrity check: ${(e as Error).message}`);
  }
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
