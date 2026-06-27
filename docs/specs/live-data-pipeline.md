# Live data pipeline

Reasoning behind the live worker, reconciler, and the feed-specific
workarounds. The code itself ([src/lib/data/live/](../../src/lib/data/live/),
[src/lib/domain/reconcile.ts](../../src/lib/domain/reconcile.ts)) is the
implementation; this doc captures the **why** that isn't there.

## Source priority

| Source | Default | Why |
|---|---|---|
| GTFS-RT (vehicle_positions) | Always on for feeds that have `realtime.vehicle_positions` in [feeds.json](feeds-json.md) | Public, free, no key, canonical `trip_id` matches the GTFS schedule |
| Tranzy | Opt-in (user provides API key) | Faster freshness (~60 s ahead of RT median) + corroboration; key-gated |

Empirical comparison: [../investigation/tranzy-vs-gtfsrt.md](../investigation/tranzy-vs-gtfsrt.md).

## Why GTFS-RT is the default

Pre-v2, the app used Tranzy as primary. Three reasons that flipped:

1. **No key required** — first-launch UX has zero friction.
2. **Canonical trip_ids** — RT `trip_id` exactly matches our SQLite, so
   reconciliation is a direct JOIN. Tranzy's id format diverges.
3. **Operational fields** — `current_status`, `bearing`,
   `current_stop_sequence`, `next_stop_id` aren't in Tranzy.

## Reconciler algorithm

Per [reconcile.ts](../../src/lib/domain/reconcile.ts):

1. Group live observations by `(routeId, directionId)`.
2. For each cohort, enumerate all `(live, scheduled)` pairs whose
   start-time delta is within an adaptive tolerance (headway-derived,
   clamped, with a fallback window).
3. Sort all candidate pairs by ascending `|delta|`.
4. Greedy-assign: bipartite matching where each live obs and each
   scheduled row participates in at most one pairing.

**Why bipartite greedy (not first-come)**: the older first-come walk
let a high-delta match claim a slot before a perfect-delta match got
a chance. Bipartite greedy guarantees perfect matches always win.

Future direction: see [../plan/prediction-v2.md](../plan/prediction-v2.md).

## Direction-id resolution

The Cluj GTFS-RT feed (`cluj-rt-feed.gtfs.ro`) sets
`TripDescriptor.direction_id = 0` for every vehicle regardless of the
actual run. The real direction is encoded in the `trip_id` second segment:

```
13_0_LV_79_1504  → dir 0
13_1_LV_70_1448  → dir 1
```

`resolveDirectionId(claimed, tripId)` in
[gtfsRtClient.ts](../../src/lib/data/live/gtfsRtClient.ts) prefers the
trip_id-encoded value when the trip_id matches the canonical
`<route>_<dir>_...` pattern, falls back to the claimed value otherwise.

Feed-agnostic: a feed whose `trip_id` doesn't carry a direction segment
hits the fallback path and keeps the original behavior. No allowlist needed.

## Timezone discipline

All wall-clock math uses the **feed's** timezone (from
[feeds.json](feeds-json.md)`.timezone`), not the system's. The reconciler
accepts `{ nowMs, timezone }`; internal conversion uses
`minSinceMidnightInTz` — single tz path through the whole stack.

This was a latent v2 bug at one point: pages computed `nowMinSinceMidnight`
in system-local tz and compared to feed-local scheduled times. In Cluj
(UTC+3) that's a 3-hour skew, enough to mis-bucket every row. Now centralized.

## CORS

Tranzy sends `Access-Control-Allow-Origin: *`, so the worker can fetch directly.

GTFS-RT feeds do NOT, so a Netlify Edge proxy at `/api/rt/<feed>/<endpoint>`
forwards with a short cache. Vite dev server mirrors the same proxy paths
in [vite.config.ts](../../vite.config.ts) so the same client code works in
both environments.

## Freshness rules

- > 5 min stale → reclassify the live entry as `scheduled` (no longer
  trusted as live, schedule takes over).
- > 30 min stale → drop entirely.

These thresholds live in [src/lib/domain/config.ts](../../src/lib/domain/config.ts);
adjust there, not in this doc.
