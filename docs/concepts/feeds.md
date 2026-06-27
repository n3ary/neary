# Feeds

A **feed** is one transit dataset: GTFS schedule + optional GTFS-RT URLs +
metadata. Multiple feeds coexist; the app holds many SQLite blobs in OPFS
and switches between them.

A feed may contain multiple **agencies** (GTFS `agency.txt` rows). The user
never picks an agency — they pick a feed.

## Where feeds come from

The [neary-gtfs](https://github.com/ciotlosm/neary-gtfs) repo publishes
[feeds.json](../specs/feeds-json.md) to the `binaries` branch on GitHub,
read by the app via `raw.githubusercontent.com`. The schema and per-feed
fields are documented there.

## Identity

Each feed has a stable string `id` (e.g. `"cluj-napoca"`, `"bucuresti-ilfov"`).
The id is what:

- `userPrefs.feedId` stores.
- The OPFS file is named after (`<id>.sqlite3`).
- Favorites are scoped to (`{ feedId, stopId }`).

## Per-feed scoping

- **Favorites** key on `{ feedId, stopId }` because the same numeric stop_id
  in Cluj and Bucharest refers to different stops.
- **Live worker** polls only the active feed's `realtime` URLs.
- **Reconciler** only sees vehicles for the active feed's `agencies`.

## Lifecycle

See [../specs/multi-feed-data-lifecycle.md](../specs/multi-feed-data-lifecycle.md) for:
- Cold vs warm switch flow
- Freshness checks (ETag + per-feed hash)
- LRU eviction (~100 MB budget)
- Pin-for-offline
- Offline behavior matrix
