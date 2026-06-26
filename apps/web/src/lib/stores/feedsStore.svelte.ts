/*
 * Singleton store backing the feed registry across components.
 *
 * One fetch per app session; everyone reads through `feedsStore.feeds`.
 * Without this, every component that needs the registry would re-fetch.
 *
 * No persistence — the registry is small (~few KB) and effectively static
 * for the lifetime of an app session. jsDelivr's 12h CDN cache + browser
 * cache handle repeat-load latency.
 */

import { fetchFeeds, type Feed } from '$lib/data/feeds';

class FeedsStore {
  feeds = $state<Feed[] | null>(null);
  loading = $state(false);
  error = $state<string | null>(null);
  /** Id of the feed currently bound to the GTFS worker (set by +layout
   *  after `repo.setFeed(...)` resolves). Consumers gate their queries
   *  on this rather than `userPrefs.feedId` to avoid racing the bind. */
  boundFeedId = $state<string | null>(null);

  /** Idempotent — safe to call from multiple effects. */
  async load(): Promise<void> {
    if (this.feeds || this.loading) return;
    this.loading = true;
    this.error = null;
    try {
      this.feeds = await fetchFeeds();
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.loading = false;
    }
  }

  byId(id: string | null | undefined): Feed | null {
    if (!id || !this.feeds) return null;
    return this.feeds.find((f) => f.id === id) ?? null;
  }

  /** The bound feed's IANA timezone, falling back to 'UTC' while the
   *  registry is still loading or the worker isn’t bound yet. Single
   *  source for every consumer of the schedule-pipeline (page-level
   *  composers, prediction helpers) so we never silently mix
   *  system-local time with feed-local time. */
  get activeTimezone(): string {
    return this.byId(this.boundFeedId)?.timezone ?? 'UTC';
  }
}

export const feedsStore = new FeedsStore();
