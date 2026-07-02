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
└──────────────────────▲──────────────────────────────────┘
                       │ repository API + reconciled broadcast
┌──────────────────────┴──────────────────────────────────┐
│ GTFS Worker                                             │
│  - SQLite-WASM + OPFS (schema = real GTFS)              │
│  - GTFS-RT poller (15 s) + protobuf decode              │
│  - reconcileWithLive(activeTrips, liveObs)              │
│  - Comlink RPC + ReconciledSnapshot broadcast           │
└─────────────────────────────────────────────────────────┘
```

Source files:
- UI: [src/routes/](../../src/routes/), [src/lib/ui/](../../src/lib/ui/)
- Domain: [src/lib/domain/](../../src/lib/domain/)
- GTFS worker: [src/lib/workers/gtfs.worker.ts](../../src/lib/workers/gtfs.worker.ts)
- Live data parser: [src/lib/data/live/](../../src/lib/data/live/) (imported by the worker)
- Stores: [src/lib/stores/](../../src/lib/stores/) — notably [reconciledVehiclesStore](../../src/lib/stores/reconciledVehiclesStore.svelte.ts)

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
   Cloudflare R2 bucket (via `gtfs.n3ary.com`).
2. User's feed selection (or auto-pick by GPS bbox) → worker downloads the feed's
   `.sqlite3.gz` to OPFS, opens it.
3. Page renders `StationCard`s from the worker's `getStationBoardsNear` /
   `getStationBoard` queries.
4. GTFS worker also polls GTFS-RT every 15 s, runs `getActiveTrips`,
   reconciles live observations against the active set, and broadcasts a
   [Vehicle](../concepts/vehicle.md)[] (`ReconciledSnapshot`) to every
   subscriber via [reconciledVehiclesStore](../../src/lib/stores/reconciledVehiclesStore.svelte.ts).
5. Domain layer joins reconciled vehicles into per-stop boards by
   `tripId` (`mergeReconciledIntoStationBoard`), classifies them into
   [arrival buckets](../concepts/arrival-buckets.md), and the UI
   re-renders.

Full data pipeline: [data-pipeline.md](data-pipeline.md).
Multi-feed lifecycle in the worker: [../specs/multi-feed-data-lifecycle.md](../specs/multi-feed-data-lifecycle.md).

## Three root-cause fixes vs v1

1. **Real GTFS in SQLite.** No dedup hacks, no in-memory Maps, no 5 MB
   localStorage gymnastics. Schema = real GTFS.
2. **All heavy work in workers.** GTFS queries, GTFS-RT polling, and
   reconciliation all live in the single SQLite-WASM worker. The UI
   thread reads from `reconciledVehiclesStore`; no live polling on main.
3. **Vehicle taxonomy is data.** Discriminated union encodes what we know
   about each vehicle's position source — see
   [../concepts/vehicle.md](../concepts/vehicle.md).

## Feed-agnostic by construction

The app consumes GTFS as a contract; it carries no per-feed knowledge.
Any non-conformance (e.g. `route_desc` duplicating `route_long_name`,
placeholder route colors, malformed RT payloads) is fixed in the
producer — neary-gtfs or the upstream source adapter — never patched
here. Rules: [../standards/feed-agnostic.md](../standards/feed-agnostic.md).
