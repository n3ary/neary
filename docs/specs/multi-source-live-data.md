# Multi-source live data

Goal: let neary consume **N live GTFS-RT sources per feed** and let the
existing reconciler dedupe observations across them. Today
`realtime.vehicle_positions` in [feeds.json](feeds-json.md) is a single
URL; this spec turns it into a list.

## Why a spec

Three things have to agree:
- The [feeds.json](feeds-json.md) schema (cross-repo contract).
- The worker's live pipeline (what it fetches, how observations merge).
- The non-goals — what we explicitly will NOT build (provider-specific
  clients, client-side secrets).

The implementation will live in the worker and is small. The reasoning
that doesn't fit in the code is here.

## What we want

A feed config can declare multiple `realtime.vehicle_positions` URLs.
The worker fetches each in parallel, decodes them as **plain GTFS-RT
protobuf**, merges the observations, and feeds the merged set to
`reconcileWithLive`. No source is special: each is just bytes that
parse as `FeedMessage`.

For agencies that don't publish GTFS-RT natively (e.g. operators
exposing a custom JSON API), a separate adapter service converts
that API to GTFS-RT and exposes a URL. That adapter is **out of
scope for this repo** — it can live anywhere (a Worker / Lambda /
Cloud Function on any host). From neary's POV it's just another
GTFS-RT URL in `realtime.vehicle_positions[]`.

## What we explicitly will NOT do

- **No API keys in the client.** If a source needs a key, the adapter
  service holds it; neary fetches a plain unauthenticated URL.
- **No provider-specific clients in neary.** No per-operator SDKs,
  no per-operator JSON shape, no per-operator auth. The worker only
  speaks GTFS-RT protobuf.
- **No client-side per-source reconciliation.** Merging across sources
  for the same physical vehicle is the reconciler's job (already in
  [src/lib/domain/reconcile.ts](../../src/lib/domain/reconcile.ts)),
  not the fetch layer.

## Config shape

`feeds.json` per-feed `realtime.vehicle_positions` becomes a
`string | string[]`. Single-URL strings stay valid (back-compat); arrays
declare multiple sources.

```jsonc
{
  "realtime": {
    "vehicle_positions": [
      "https://cluj-rt-feed.gtfs.ro/vehiclePositions",
      "https://second-source-adapter.example/cluj/vehicle_positions"
    ],
    "trip_updates": "…",      // stays single (no use case yet)
    "service_alerts": "…"
  }
}
```

The schema lives in the [neary-gtfs](https://github.com/ciotlosm/neary-gtfs)
repo (`schemas/feeds.schema.json`). When this contract lands, that schema
adds a `oneOf: [string, array<string>]` and the app reader normalises to
an array internally.

## Worker behaviour

Per tick (every 15 s today, see
[live-data-pipeline.md](live-data-pipeline.md)):

1. **Fetch in parallel.** One `fetch()` per URL with the same timeout
   budget as today. A source returning non-200, malformed protobuf, or
   timing out is dropped from this tick — other sources still feed
   the reconciler.
2. **Decode each independently.** Each response is a GTFS-RT
   `FeedMessage`. Decode to the worker's existing internal
   `VehicleObservation[]` shape.
3. **Merge into a single observation set.** Same-vehicle dedup runs
   here (same `vehicle.id`, or same `trip.tripId` if vehicle.id is
   missing, with the **freshest** `timestamp` winning). The merge
   step is per-tick and stateless across ticks — no rolling buffers.
4. **Reconcile.** Pass the merged set to `reconcileWithLive` exactly
   as today. The reconciler already handles trip_id drift and orphan
   live observations; multi-source just gives it more observations to
   work with.

Source identity is not currently surfaced to the UI. The
[debug overlay](../../src/lib/ui/VehicleCard.svelte) renders
`tripId · kind · dir` regardless of which source produced the
observation. If a need surfaces to label rows by source ("this row
came from the second adapter"), add a `sources: string[]` field on
`Vehicle.liveSources` (already a field, currently set to `['gtfs-rt']`).

## Failure modes

| Failure | Behaviour |
|---|---|
| One source returns 5xx / times out | Tick succeeds with the other sources' observations; logged once per failed source per tick. |
| All sources fail | Reconciler runs on an empty observation set: every vehicle drops to `kind: scheduled` for this tick. Same behaviour as today's single-source-down case. |
| Two sources report the same vehicle at conflicting positions | The freshest `timestamp` wins (per-vehicle dedup in step 3). If timestamps tie, source order in the config array breaks the tie. |
| A source publishes malformed protobuf | Same as 5xx — dropped this tick, logged. |

No backoff state, no per-source health flag, no quotas in this layer.
The adapter service is responsible for rate-limiting its upstream; from
neary's POV every source is a URL that either returns bytes or doesn't.

## Out of scope

- The adapter implementations themselves (any provider → GTFS-RT
  bridge). Live in their own repos / deployments.
- Per-source health UI / "source X is down" indicators.
- Source attribution badges in the UI.
- Trip updates / service alerts multi-source. Single-URL stays for
  those until there's a real consumer.

## References

- [Live data pipeline](live-data-pipeline.md) — single-source worker
  flow today.
- [feeds.json](feeds-json.md) — config shape that grows here.
