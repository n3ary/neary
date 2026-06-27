# System overview

The neary v2 app is a static SvelteKit PWA that consumes a multi-feed GTFS
catalog published by the separate [neary-gtfs](https://github.com/ciotlosm/neary-gtfs)
repo. All heavy work runs in workers; the UI thread does layout and events only.

## High-level components

```
┌─────────────────────────────────────────────────────────┐
│ UI (Svelte 5 + Tailwind, main thread)                   │
│  - 4 top-level views + drill-downs                      │
│  - Subscribes to stores via $state / $derived           │
└──────────────────────▲──────────────────────────────────┘
                       │ typed events / signals
┌──────────────────────┴──────────────────────────────────┐
│ Domain (pure TS, framework-free, unit-tested)           │
│  - Buckets, prediction, reconciler, shape projection    │
│  - Vehicle discriminated union — see                    │
│    ../concepts/vehicle.md                               │
└──────────▲────────────────────────────▲─────────────────┘
           │ repository API             │ live data API
┌──────────┴─────────────┐  ┌───────────┴─────────────────┐
│ GTFS Worker            │  │ Live Worker                  │
│  - SQLite-WASM + OPFS  │  │  - GTFS-RT poller (15s)     │
│  - Schema = real GTFS  │  │  - Optional Tranzy poller   │
│  - Comlink RPC         │  │  - Emits Vehicle[]          │
└────────────────────────┘  └─────────────────────────────┘
```

Source files:
- UI: [src/routes/](../../src/routes/), [src/lib/ui/](../../src/lib/ui/)
- Domain: [src/lib/domain/](../../src/lib/domain/)
- GTFS worker: [src/lib/workers/gtfs.worker.ts](../../src/lib/workers/gtfs.worker.ts)
- Live worker: [src/lib/data/live/](../../src/lib/data/live/)
- Stores: [src/lib/stores/](../../src/lib/stores/)

## Top-level views

| Route | Purpose |
|---|---|
| `/` | Stations — closest stop + optional pair, board assembled from schedule + live |
| `/favorites` | Saved routes per-feed, picker for each route |
| `/planner` | Reserved (Phase 8 — not implemented) |
| `/settings` | Feed picker, theme, display toggles |

Drill-downs (path-based for shareability + iOS back button):
| Route | Purpose |
|---|---|
| `/station/[id]` | Single station board |
| `/schedule/route/[id]/[[view]]` | Per-route schedule (today / tomorrow / week) |
| `/map/route/[id]/[[selected]]` | Per-route map with vehicles + shape |

## Data flow at a glance

1. PWA loads → fetch [feeds.json](../specs/feeds-json.md) from the
   `binaries` branch on GitHub (via `raw.githubusercontent.com`).
2. User's feed selection (or auto-pick by GPS bbox) → worker downloads the feed's
   `.sqlite3.gz` to OPFS, opens it.
3. Page renders `StationCard`s from the worker's `getStationBoardsNear` /
   `getStationBoard` queries.
4. Live worker (if running) polls GTFS-RT every 15 s and pushes
   [Vehicle](../concepts/vehicle.md)[] updates.
5. Domain layer reconciles live + scheduled into board entries, classifies
   them into [arrival buckets](../concepts/arrival-buckets.md), and the UI
   re-renders.

Full data pipeline: [data-pipeline.md](data-pipeline.md).
Multi-feed lifecycle in the worker: [../specs/multi-feed-data-lifecycle.md](../specs/multi-feed-data-lifecycle.md).

## Three root-cause fixes vs v1

1. **Real GTFS in SQLite.** No dedup hacks, no in-memory Maps, no 5 MB
   localStorage gymnastics. Schema = real GTFS.
2. **All heavy work in workers.** GTFS queries in the DB worker; live
   polling + reconciliation in the live worker.
3. **Vehicle taxonomy is data.** Discriminated union encodes what we know
   about each vehicle's position source — see
   [../concepts/vehicle.md](../concepts/vehicle.md).
