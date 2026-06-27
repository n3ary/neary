# Data pipeline

How GTFS data gets from the world into the app.

## Upstream: neary-gtfs

The separate [neary-gtfs](https://github.com/ciotlosm/neary-gtfs) repo runs
a daily GitHub Action (00:30 UTC) that:

1. Reads `countries.json` (whitelist of Transitous source names).
2. For Cluj-Napoca: scrapes ctpcj.ro CSV timetables, rebuilds a GTFS zip on
   top of a Transitous seed.
3. For other feeds: mirrors Transitous's resolved zip directly.
4. Auto-discovers GTFS-RT URLs via MobilityData's catalog.
5. Converts each feed's `.gtfs.zip` to `.sqlite3.gz`.
6. Writes [feeds.json](../specs/feeds-json.md) (Ajv-validated against
   `schemas/feeds.schema.json`).
7. Force-pushes `outputs/` to the `binaries` branch.

All published artifacts are served raw from the `binaries` branch on GitHub:
`https://raw.githubusercontent.com/ciotlosm/neary-gtfs/binaries/feeds.json`

A former plan to front them via jsDelivr was dropped because
`cdn.jsdelivr.net` intermittently 502s on this branch's binary files
even when the JSON is cached fine.

## App side: cold start

```
PWA boot
   │
   ├─ fetch feeds.json (ETag-aware) ──► feedsStore
   │
   ├─ user picks feed (or auto-pick by GPS bbox)
   │      │
   │      ▼
   │  GTFS worker: setFeed(id)
   │      │
   │      ├─ already in OPFS + hash matches? open it (warm, <100ms)
   │      └─ else: stream sqlite_gz from `raw.githubusercontent.com/<repo>/binaries/...`, write OPFS, open it
   │
   ├─ getStationBoardsNear(lat, lon, radius)
   │      │ joins stops + stop_times + trips + active services
   │      ▼
   │  Vehicle[] of kind="scheduled" / "predicted"
   │
   └─ live worker: start polling GTFS-RT (15s cadence)
          │
          ▼
      reconciler joins live observations into the board
          │
          ▼
      Vehicle[] now includes kind="reconciled" / "live"
```

Lifecycle details (eviction, pinning, offline behavior) live in
[../specs/multi-feed-data-lifecycle.md](../specs/multi-feed-data-lifecycle.md).

## App side: steady state

| Loop | Cadence | What it does |
|---|---|---|
| Live poll (L1) | 15 s | GTFS-RT vehicle positions → live worker → reconciler |
| UI tick (L2) | 15 s | Re-evaluate ETAs / buckets against new wall-clock |
| Manual refresh (L3) | on tap | Refresh button forces L1 + L2 immediately |

The three loops are decoupled. Refresh button reasoning: see
[../plan/prediction-v2.md §6.5](../plan/prediction-v2.md).

## Storage layout

- `feeds.json` → in-memory (small, refetched on launch).
- `<feedId>.sqlite3` → OPFS (~4–30 MB per feed, multiple feeds coexist).
- `feeds-meta.json` → OPFS (per-feed bookkeeping: hash, last_used_at, pinned).
- `userPrefs` → localStorage (theme, feedId, toggles).
- `favorites` → localStorage, scoped per feed.

OPFS budget cap is ~100 MB; eviction policy and switch flow in
[../specs/multi-feed-data-lifecycle.md](../specs/multi-feed-data-lifecycle.md).
