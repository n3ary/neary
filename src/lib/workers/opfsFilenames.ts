/*
 * OPFS filename helpers for the GTFS worker. Pure — no SQLite, no
 * OPFS handle interaction beyond a thin pool interface, so the
 * worker module can stay focused on bootstrap + queries.
 *
 * The worker stores each feed's schedule database as a single file
 * inside the OPFS-SAHPool VFS. The filename embeds a short slice of
 * the feed's `hash` field (from feeds.json) so a new upstream build
 * surfaces as a different filename, the existing-file check misses,
 * and the worker re-downloads.
 *
 * Without this, the worker would happily serve last week's sqlite
 * forever for any user whose first install pre-dated the new build.
 */

import type { Feed } from '$lib/data/feeds';

/** Minimal slice of the SQLite-WASM SAHPoolUtil we depend on. Lets
 *  unit tests pass a hand-rolled stub without pulling in the wasm. */
export interface SahPoolLike {
  getFileNames(): string[];
  unlink(filename: string): boolean;
}

/** Legacy hash-less filename, kept so we can recognize and prune
 *  files written before this change shipped. */
export function opfsFileForLegacy(feedId: string): string {
  return `/${feedId}.sqlite3`;
}

/** Hash-versioned filename. First 12 hex chars of the feed's
 *  `hash` (`"sha256-<hex>"`) are enough to make collisions
 *  effectively impossible between published builds. Falls back to
 *  the legacy unsuffixed name when `feed.hash` is missing/empty,
 *  so feeds whose registry entry doesn't carry a hash yet keep
 *  working with the pre-change behavior. */
export function opfsFileFor(feed: Feed): string {
  const slice = feed.hash?.replace(/^sha256-/, '').slice(0, 12);
  return slice ? `/${feed.id}-${slice}.sqlite3` : opfsFileForLegacy(feed.id);
}

/** Every OPFS entry belonging to `feedId` — the legacy hash-less file
 *  plus every hash-versioned snapshot.
 *
 *  Match rule: a filename belongs to `feedId` when it is either
 *  the legacy `/<feedId>.sqlite3` or a versioned
 *  `/<feedId>-<12-hex>.sqlite3`. The strict 12-hex tail prevents
 *  the prefix `/cluj-napoca-` from accidentally matching a
 *  hypothetical sibling feed like `/cluj-napoca-night.sqlite3`. */
export function feedDbFiles(pool: SahPoolLike, feedId: string): string[] {
  const legacy = opfsFileForLegacy(feedId);
  // Escape `feedId` because a future id could contain regex
  // metacharacters even though today's feed ids are all kebab-case.
  const escaped = feedId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const versionedRe = new RegExp(`^/${escaped}-[0-9a-f]{12}\\.sqlite3$`);
  return pool.getFileNames().filter((name) => name === legacy || versionedRe.test(name));
}

/** Remove every OPFS entry belonging to `feedId` except `keep`. */
export function pruneStaleFeedFiles(
  pool: SahPoolLike,
  feedId: string,
  keep: string,
): number {
  let removed = 0;
  for (const name of feedDbFiles(pool, feedId)) {
    if (name === keep) continue;
    if (pool.unlink(name)) removed += 1;
  }
  return removed;
}
