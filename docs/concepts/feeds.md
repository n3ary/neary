# Feeds

A **feed** is one transit dataset: GTFS schedule + optional GTFS-RT URLs +
metadata. Multiple feeds coexist; the app holds many SQLite blobs in OPFS
and switches between them.

A feed may contain multiple **agencies** (GTFS `agency.txt` rows). The user
never picks an agency — they pick a feed.

## Where feeds come from

The [gtfs](https://github.com/n3ary/gtfs) repo publishes
[feeds.json](../specs/feeds-json.md) to Cloudflare R2, read by the app
via `gtfs.n3ary.com`. The schema and per-feed fields are documented
there.

## Identity

Each feed has a stable string `id` (e.g. `"cluj-napoca"`, `"bucuresti-ilfov"`).
The id is what:

- `userPrefs.feedId` stores.
- The OPFS file is named after (`<id>.sqlite3`).
- Favorites are scoped to (`{ feedId, stopId }`).

## Per-feed scoping

The worker is bound to **one feed at a time** — its open SQLite DB and its
GTFS-RT poll target are both that feed's. Switching feeds re-binds both.
Consequences:

- **Favorites** key on `{ feedId, stopId }` because the same numeric
  stop_id in Cluj and Bucharest refers to different stops.
- **Live data is feed-scoped by construction.** The worker polls only the
  active feed's `realtime` URL, reconciles those observations against
  that feed's schedule, and broadcasts the result via
  [reconciledVehiclesStore](../../src/lib/stores/reconciledVehiclesStore.svelte.ts).
  No filtering by `agencies` happens — there's only one feed's data in
  flight at any moment.

## Lifecycle

See [multi-feed-data-lifecycle.md](../specs/multi-feed-data-lifecycle.md) for:
- Cold vs warm switch flow
- Freshness checks (ETag + per-feed hash)
- LRU eviction (~100 MB budget)
- Pin-for-offline
- Offline behavior matrix
