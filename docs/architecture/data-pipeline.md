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
   │  Vehicle[] of kind="scheduled"
   │
   └─ worker: start polling GTFS-RT (15s cadence)
          │
          ▼
      reconcileWithLive(activeTrips, liveObs) inside the worker
          │
          ▼
      ReconciledSnapshot broadcast to reconciledVehiclesStore
          │
          ▼
      Per-view tripId merge → Vehicle[] mix of
      kind="scheduled" / "tracked" / "gps-only" / "verified"
```

Lifecycle details (eviction, pinning, offline behavior) live in
[../specs/multi-feed-data-lifecycle.md](../specs/multi-feed-data-lifecycle.md).

## App side: steady state

| Loop | Cadence | What it does |
|---|---|---|
| Live poll (L1) | 15 s | GTFS worker: fetch GTFS-RT → reconcileWithLive → broadcast `ReconciledSnapshot` |
| UI tick (L2) | 15 s | Re-evaluate ETAs / buckets against new wall-clock |
| Manual refresh (L3) | on tap | Refresh button forces L1 + L2 immediately |

The three loops are decoupled. Refresh button reasoning: see
[../plan/prediction-v2.md §6.5](../plan/prediction-v2.md).

## ETA inputs shared by station + map

GPS-backed rows (`kind: 'tracked'`, `kind: 'gps-only'`) run through one
domain entry point in both views:
[`predictArrivalFromGps`](../../src/lib/domain/predictArrivalAlongShape.ts).
It encapsulates raw-GPS dead-reckon + per-segment + dwell walk. Views
MUST NOT call `deadReckonGpsAlongShape` + `predictArrivalAlongShape`
themselves — that risks double extrapolation.

Inputs joined per trip:

| Input | Worker query | Used by |
|---|---|---|
| Trip polyline | `getShapesForTrips` | Map markers and station ETA |
| Per-stop `shape_dist_traveled[]` | `getStopDistancesForTrips` (station) / inline on `getRouteMapView` (map) | Per-segment + dwell walk |

Values come from neary-gtfs's `stop_times.shape_dist_traveled` (Cluj
writes it at build time via the timing/shape pipeline). Trips missing
the column fall back to single-segment ETA.

## Storage layout

- `feeds.json` → in-memory (small, refetched on launch).
- `<feedId>.sqlite3` → OPFS (~4–30 MB per feed, multiple feeds coexist).
- `feeds-meta.json` → OPFS (per-feed bookkeeping: hash, last_used_at, pinned).
- `userPrefs` → localStorage (theme, feedId, toggles).
- `favorites` → localStorage, scoped per feed.

OPFS budget cap is ~100 MB; eviction policy and switch flow in
[../specs/multi-feed-data-lifecycle.md](../specs/multi-feed-data-lifecycle.md).
