# Live data pipeline

Reasoning behind the worker-side live pipeline, reconciler, and
consumer-side behaviour. The code itself
([src/lib/data/live/](../../src/lib/data/live/),
[src/lib/domain/reconcile.ts](../../src/lib/domain/reconcile.ts)) is the
implementation; this doc captures the **why** that isn't there.

For the **producer/consumer split** on per-feed RT cleanup (who
recovers broken `direction_id`, who merges multi-source feeds), see
[gtfs-rt-contract.md](gtfs-rt-contract.md). This doc covers what
the consumer does given a clean, spec-compliant RT feed.

## Where it runs

The GTFS-RT poll, protobuf decode, active-trips SQL query, and
reconciliation all run **inside the SQLite-WASM worker**
([src/lib/workers/gtfs.worker.ts](../../src/lib/workers/gtfs.worker.ts)).
The worker broadcasts a `ReconciledSnapshot` (`Vehicle[]` plus status
fields) every 15 s; every view consumes the same broadcast via
[`reconciledVehiclesStore`](../../src/lib/stores/reconciledVehiclesStore.svelte.ts).

Why worker-side: pre-refactor each view ran its own `reconcileWithLive`
against a per-view scheduled subset. The map view used string-equality
trip_id lookups while station cards used (route, dir, tripStartMin)
tolerance matching, so the map drew a marker for both the scheduled
trip *and* the drifted live obs of the same physical bus — empirically
~6 % duplicate markers across the Cluj fleet at peak hours. Centralizing
reconciliation in the worker means every consumer reads the same
deduplicated set.

Station views still keep their per-stop `getStationBoard` fetch (the
worker doesn't know the consumer's stop) and join the global reconciled
set by `tripId` via `mergeReconciledIntoStationBoard` — promoting
matched rows to `kind: 'tracked'` and appending route-relevant
`kind: 'gps-only'` orphans with a sibling-derived ETA seed.

## Source priority

| Source | Default | Why |
|---|---|---|
| GTFS-RT (vehicle_positions) | Always on for feeds that have `realtime.vehicle_positions` in [feeds.json](feeds-json.md) | Public, free, no key, full operational fields |

Additional live sources are added as more GTFS-RT URLs in the same
field (see [multi-source-live-data.md](multi-source-live-data.md)).
Any non-GTFS-RT provider is out of scope for neary itself and lives
in an adapter service that emits GTFS-RT.

## Why GTFS-RT (and only GTFS-RT)

1. **Bigger field surface** — `current_status`, `bearing`,
   `current_stop_sequence`, `next_stop_id` are all standardized.
2. **Direct trip-level metadata** — `trip_id`, `route_id`,
   `direction_id` come out of the box.
3. **No API keys in the client.** If a source needs auth, the
   adapter service holds the key; neary only speaks the open,
   unauthenticated protocol.

> [!CAUTION]
> Earlier versions of this doc claimed RT's `trip_id` matches our
> static SQLite exactly and reconciliation could be a JOIN. **That
> claim was wrong** for Cluj and is suspect for any feed where the
> static and RT pipelines run independently. See "Trip-id drift"
> below — the reconciler matches by `(routeId, directionId,
> tripStartMin)` with adaptive timing tolerance, not by trip_id.

## Trip-id drift (Cluj — and probably others)

Both CTP's static feed and CTP's GTFS-RT feed share the same
trip_id schema:

```
<route_id>_<direction_id>_<service_id>_<run>_<HHMM>
e.g.  43_1_S_36_1950   (route 43, dir 1, Saturday, run 36, dep 19:50)
```

But the two systems populate `<run>` and `<HHMM>` from **independent
dispatch databases**, not from a shared key. Field samples taken
2026-06-27 against the live Cluj RT feed and our published static:

| Live trip_id       | Closest static       | Δ |
|---|---|---|
| `8_0_S_32_1935`    | `8_0_S_32_1932`      | same run, +3 min |
| `30_0_S_44_1932`   | `30_0_S_43_1932`    | same HHMM, run off by 1 |
| `43_1_S_37_1940`   | `43_1_S_35_1930` / `_36_1950` | no exact peer — operator inserted an extra 19:40 run between static 19:30 and 19:50 |

Out of 84 sampled live trip_ids that day, **65 (77 %) matched a
static trip_id exactly; 19 (23 %) did not**. The static feed was
complete for every route + service in the unmatched set — the
divergence is purely the `<run>_<HHMM>` tail. CTP's operations team
dispatches buses on a tighter clock than the published timetable.

So a "match by trip_id" reconciler would silently drop ~20–25 % of
the live fleet at peak hours. The current reconciler bridges the
gap with `(routeId, directionId, tripStartMin)` matching and an
adaptive tolerance window — see next section.

## Reconciler algorithm

Per [reconcile.ts](../../src/lib/domain/reconcile.ts):

1. Group live observations by `(routeId, directionId)`.
2. For each cohort, enumerate all `(live, scheduled)` pairs whose
   start-time delta is within an adaptive tolerance (headway-derived,
   clamped, with a fallback window).
3. Sort all candidate pairs by ascending `|delta|`.
4. Greedy-assign: bipartite matching where each live obs and each
   scheduled row participates in at most one pairing.
5. **Emit `kind: 'gps-only'` for unmatched live observations** whose
   `(routeId, directionId)` shows up on the caller's board (i.e.
   the route serves this station/view). Headsign + route info are
   copied from a representative scheduled sibling on the same
   `(routeId, directionId)`.

**Why bipartite greedy (not first-come)**: the older first-come walk
let a high-delta match claim a slot before a perfect-delta match got
a chance. Bipartite greedy guarantees perfect matches always win.

**Why orphan emission lives in the reconciler**: the page used to
synthesize `kind: 'gps-only'` rows from sibling lookups (PR #69, #72).
That duplicated reconciliation state across the page-domain boundary
and put inclusion gating + headsign hydration on the wrong side.
The reconciler already has both the live observations and the scheduled
rows in hand —
emitting orphans there keeps the boundary clean. The station-side
`mergeReconciledIntoStationBoard` only **re-seeds** the orphan ETA
using a per-stop sibling's travel-time-from-origin (the global
reconciler doesn't know the consumer's stop, so its ETA is
terminus-relative).

Future direction: see [concepts/prediction.md](../concepts/prediction.md) and open issues #106, #162, #163.

## Direction-id resolution

The consumer treats `direction_id` as authoritative. Per
[gtfs-rt-contract.md](gtfs-rt-contract.md), the producer's adapter is
responsible for populating `direction_id` correctly (including
synthesising it from operator-internal encodings when the upstream
publishes `direction_id=0` for every vehicle). The consumer does not
fall back to `trip_id` parsing — that would put per-feed knowledge back
into the consumer.

## Timezone discipline

All wall-clock math uses the **feed's** timezone (from
[feeds.json](feeds-json.md)`.timezone`), not the system's. The reconciler
accepts `{ nowMs, timezone }`; internal conversion uses
`minSinceMidnightInTz` — single tz path through the whole stack.

This was a latent v2 bug at one point: pages computed `nowMinSinceMidnight`
in system-local tz and compared to feed-local scheduled times. In Cluj
(UTC+3) that's a 3-hour skew, enough to mis-bucket every row. Now centralized.

## CORS

GTFS-RT feeds don't set CORS headers on their responses, so the
worker can't fetch them directly. A Cloudflare Pages Function at
`/api/rt/<feed>/<endpoint>` (see
[functions/api/rt/[feed]/[[endpoint]].js](../../functions/api/rt/[feed]/[[endpoint]].js))
resolves the upstream URL from [feeds.json](feeds-json.md) and
proxies the response on the app's own origin. Vite dev server
mirrors the same proxy paths in [vite.config.ts](../../vite.config.ts)
so the same client code works in both environments.

## Freshness rules

- > 5 min stale → reclassify the live entry as `scheduled` (no longer
  trusted as live, schedule takes over).
- > 30 min stale → drop entirely.

These thresholds live in [src/lib/domain/config.ts](../../src/lib/domain/config.ts);
adjust there, not in this doc.

## Test fixture

[src/lib/data/live/__fixtures__/cluj-vehicle-positions.bin](../../src/lib/data/live/__fixtures__/cluj-vehicle-positions.bin)
is a 15 KB protobuf capture of a real Cluj `vehicle_positions` response
from 2026-06-27. Used by
[gtfsRtClient.test.ts](../../src/lib/data/live/gtfsRtClient.test.ts)
to round-trip `parseVehiclePositions` against bytes the operator
actually emits — catches regressions in `gtfs-realtime-bindings`
upgrades and upstream schema drift that a hand-built `FeedMessage`
wouldn't.

To regenerate after an upstream change (with `npm run dev` running so
the same-origin proxy is up):

```bash
curl -o src/lib/data/live/__fixtures__/cluj-vehicle-positions.bin \
  http://localhost:5173/api/rt/cluj-napoca/vehiclePositions
```

The snapshot is intentionally pinned — bumping it should be a deliberate
PR, not a passive refresh, so the diff makes any field-shape change
visible.
