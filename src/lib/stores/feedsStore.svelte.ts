// Singleton for the feed registry. One fetch per app session; everyone reads through `feedsStore.feeds`. raw.githubusercontent.com's ~5-min edge cache + browser cache handle repeat-load latency.

import { fetchFeeds, type Feed } from '$lib/data/feeds';

class FeedsStore {
  feeds = $state<Feed[] | null>(null);
  loading = $state(false);
  error = $state<string | null>(null);
  /** Set by +layout after `repo.setFeed(...)` resolves. Consumers gate queries on this rather than `userPrefs.feedId` to avoid racing the bind. */
  boundFeedId = $state<string | null>(null);
  /** In-flight setFeed id between kickoff and resolve. Distinct from `boundFeedId` so the settings row can render a spinner without falsely claiming "already bound". */
  bindingFeedId = $state<string | null>(null);
  /** Download progress 0-100 for `bindingFeedId`. Mirrors the StatusBar's onProgress counter so they stay in lockstep. */
  bindingProgress = $state<number | null>(null);

  /** Idempotent — safe to call from multiple effects. Uses `finally` so `loading`
   *  is reset even when the fetch throws. Without this, a failed load() leaves
   *  `this.loading = true` forever, and any subsequent refresh() sees loading=true
   *  and shows a spinner indefinitely. */
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

  // Coalescing re-fetch. Preserves the old list on failure so the UI doesn't flash empty.
  // Does NOT bail early when `this.loading` is true — that covers the case where load()
  // is still in-flight (e.g. the app started online, user went offline, then navigated
  // to Settings). Without this, refresh() returns immediately and the in-flight 500 from
  // load() never surfaces in the UI (spinner hangs indefinitely).
  async refresh(): Promise<void> {
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

  /** Bound feed's IANA timezone, falling back to 'UTC' while loading/unbound. Single source for every schedule-pipeline consumer so we never mix system-local with feed-local time. */
  get activeTimezone(): string {
    return this.byId(this.boundFeedId)?.timezone ?? 'UTC';
  }
}

export const feedsStore = new FeedsStore();
