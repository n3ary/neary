# Multi-feed data lifecycle

How the GTFS worker manages multiple feeds in OPFS.

Source: [src/lib/workers/gtfs.worker.ts](../../src/lib/workers/gtfs.worker.ts) is authoritative
for what's implemented; this doc owns the contract that crosses UI ↔ worker.

## Storage model

Each feed lives as one OPFS file: `/<feedId>.sqlite3`. Multiple feeds
coexist in the same OPFS-SAH pool. A worker-owned metadata blob
`/feeds-meta.json` records per-feed bookkeeping:

```jsonc
{
  "version": 1,
  "feeds": {
    "cluj-napoca":     { "hash": "sha256-…", "generated_at": "...",
                         "size_bytes": 5716840, "last_used_at": "...",
                         "pinned": false },
    "bucuresti-ilfov": { "hash": "sha256-…", "generated_at": "...",
                         "size_bytes": 27194163, "last_used_at": "..." }
  },
  "active": "cluj-napoca",
  "last_registry_check": "2026-06-26T08:14:00Z",
  "registry_etag": "W/\"abc…\""
}
```

## Switch flow

When `userPrefs.feedId` changes:

1. UI calls `setFeed(newId)` over Comlink. StatusBar shows `loading`.
2. Worker closes the current `Database` handle (file stays in OPFS).
3. If `/<newId>.sqlite3` is already in OPFS *and* its `hash` matches
   `feeds.json[newId].hash` → open it. Warm switch < 100 ms.
4. Else (cold or stale): worker streams `feed.files.sqlite_gz` from
   `gtfs.n3ary.com` (Cloudflare R2), decompresses, writes OPFS,
   updates `feeds-meta.json`, opens it. 4–20 MB → 1–5 s on a phone.
5. Old feed's OPFS file is **not deleted**. Eviction handled below.

## Freshness check

Two tiers, cheap by default:

- **Tier A** (app launch + manual refresh): `GET feeds.json` with
  `If-None-Match: <registry_etag>`. 304 → no work. 200 → diff per-feed
  `hash`. Mismatch → mark feed `stale: true`.
- **Tier B** (on stale-active-feed): surface the schedule status dot as
  yellow. User confirms update → cold path runs in background; current
  session keeps the old blob until the new one is ready, then swaps.
  Never auto-evict mid-session.

## Eviction policy

Goal: stay under ~100 MB total OPFS usage for SQLite files.

Rules (run at end of every successful switch):

1. Never evict the **active** feed.
2. Never evict a feed marked `pinned: true`.
3. If total OPFS bytes > 100 MB, evict by least-recent `last_used_at`
   until under budget.
4. When evicting a feed, also drop any favorites scoped to that feed
   (see [concepts/feeds.md](../concepts/feeds.md)). Soft-warn the
   user; they can re-pick the city to re-download.

100 MB / ~5 MB per feed ≈ 20 cities cached. iOS Safari shows an install
prompt for PWAs > 50 MB; only one feed is "hot" at a time so the app
stays under that by default.

## Pin for offline

Power-user gesture in the feed picker. Sets `pinned = true`. Pinned feeds:

- Are exempt from LRU eviction.
- Pre-fetch their `.sqlite3.gz` on next freshness update without an
  interactive prompt (progress still surfaces in StatusBar).

Use case: traveler downloads Bucharest before a trip, knows it'll work
offline on arrival.

## Offline behavior matrix

| State | UX |
|---|---|
| Active feed on-device, GPS inside its bbox | Full app works; live dot gray (RT unavailable); rows fall to `scheduled` |
| Active feed on-device, GPS outside bbox | Works; "You're outside <Name> — pick another city" banner; picker shows only cached feeds |
| Active feed not on-device | "Offline — <Name> isn't downloaded yet" StatusBar error |
| No feed ever picked, no GPS, no cached registry | "Offline — connect once to download a city" |

## GPS auto-pick

When `userPrefs.feedId` is null and we have a GPS fix, `locationStore.pickFeed(feeds)`
returns the feed whose `bbox` contains the position.

Non-obvious rules:

- **Overlapping bboxes — pick the smallest.** Rail feeds and city feeds
  routinely overlap (e.g. a national rail bbox containing all city bboxes).
  Smallest area = most specific = the feed the user actually wants.
- **Intercity routes inflate bboxes.** A feed whose stops include an
  intercity terminus has a much larger bbox than the city's footprint.
  Acceptable trade-off: auto-pick stays opinion-free, the user can always
  override via the picker.

## Worker API

```ts
interface GtfsRepo {
  setFeed(feedId: string): Promise<void>;
  listCachedFeeds(): Promise<CachedFeedMeta[]>;
  pinFeed(feedId: string, pinned: boolean): Promise<void>;
  evictFeed(feedId: string): Promise<void>;
  checkRegistryFreshness(): Promise<RegistryDiff>;
}
```

## Implementation status

Shipped:
- `setFeed` (cold switch from R2).
- Per-feed OPFS storage.

Pending app-side:
- Full LRU eviction per the rules above.
- Tier A registry ETag check on launch + manual refresh.
- Pin-for-offline UI in the feed picker.
- `locationStore.pickFeed()` auto-pick with the bbox tie-break rule.
