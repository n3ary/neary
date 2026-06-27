# Vehicles and views

Cross-cutting design contracts the code can't express alone: which views
exist, how they reach each other, what the `Vehicle` shape encodes about
position knowledge, and the non-obvious reconciliation rules that are easy
to break.

For implementation:
- Types: [src/lib/domain/types.ts](../../src/lib/domain/types.ts)
- Buckets + filters + sort: [src/lib/domain/buckets.ts](../../src/lib/domain/buckets.ts)
- Station board assembly: [src/lib/domain/stationBoard.ts](../../src/lib/domain/stationBoard.ts)
- Reconciler: [src/lib/domain/reconcile.ts](../../src/lib/domain/reconcile.ts)
- Thresholds: [src/lib/domain/config.ts](../../src/lib/domain/config.ts)

## 1. Views

Four primary views on the bottom nav, two drill-downs reachable from
multiple entry points.

| Surface | Route | What it shows |
|---|---|---|
| Stations (primary) | `/` | Nearby stations, each with its arrivals board |
| Favorites (primary) | `/favorites` | Saved routes; tap opens the drill-downs |
| Planner (primary) | `/planner` | Reserved — not yet implemented |
| Settings (primary) | `/settings` | Theme, feed picker, display toggles |
| Schedule (drill-down) | `/schedule/route/[id]/[[view]]` | Per-route schedule with today / tomorrow / week tabs |
| Map (drill-down) | `/map/route/[id]/[[selected]]` | Whole route on the map: shape + every vehicle + selected highlight |
| Station detail | `/station/[id]` | Single station board (for deep links from the map) |

### Why drill-downs are path-based

URLs are shareable, iOS PWA back-button works correctly, and same data with
a longer time horizon doesn't need a new component. The station view IS the
schedule view with a 60-min window; the schedule drill-down is the same
assembly with a 24-hour window scoped to one route.

### Entry points

| From | Tap target | Lands on |
|---|---|---|
| Stations card route badge | route id | `/schedule/route/[id]?stop=[stopId]` |
| Stations card map icon | vehicle id | `/map/route/[id]?selected=[vehicleId]` |
| Favorites saved route | card body | `/schedule/route/[id]` |
| Favorites saved route | map icon | `/map/route/[id]` |
| Map vehicle marker | marker | `/map/route/[id]?selected=[vehicleId]` |

## 2. Vehicle taxonomy

The `Vehicle` type ([types.ts](../../src/lib/domain/types.ts)) is a
discriminated union where `kind` encodes **how we know where the vehicle is**:

| Kind | Position source |
|---|---|
| `scheduled` | Trip exists in the schedule, no live match (or live not polled) |
| `predicted` | Schedule says it should be running; live sources polled, none reported it |
| `live` | Live GPS, no schedule trip matched |
| `reconciled` | Live GPS + matched scheduled trip (one live source) |
| `corroborated` | Live GPS + matched scheduled trip + two or more live sources agree |

Two metadata fields complete the row:

- `confidence: 'high' | 'medium' | 'low'` — see [../concepts/confidence.md](../concepts/confidence.md).
- `liveSources: LiveSource[]` — empty for schedule-only kinds; populated for live*.

### Why a discriminated union

One component per kind, used identically in list / schedule / map. The
reconciler is the only place that stamps `kind` and `confidence`; nothing
downstream branches on "is this real". The UI never has to guess what data
is present — the type system enforces it.

## 3. Station view

The board is a sorted, capped, filtered list of `Vehicle`s for one stop.

| Step | Where |
|---|---|
| Classify each vehicle into a bucket | `bucketOf()` in [buckets.ts](../../src/lib/domain/buckets.ts) |
| Sort by bucket, then ETA | `compareForBoard()` in the same file |
| Apply user-pref filters | `filterForStationView()` |
| Cap to 5 rows (1 per bucket, then fill from `incoming`) | `capStationBoard()` in [stationBoard.ts](../../src/lib/domain/stationBoard.ts) |

Buckets, ordering and urgency colors are documented in
[../concepts/arrival-buckets.md](../concepts/arrival-buckets.md).

### Map view bypasses the cap

The map consumes the raw `Vehicle[]` for the route directly. No bucket cap,
no per-pref filter (except `showDepartedVehicles` is honored on the station
view only — map always shows them).

## 4. Map view

| Vehicle kind | Marker fill | Border | Pane |
|---|---|---|---|
| `corroborated` | route color | 2 px route color + white outline | `corroborated` |
| `reconciled` | route color | 2 px route color | `reconciled` |
| `live` | route color | 1 px route color | `live` |
| `predicted` | route color | 1 px dashed | `predicted` |
| `scheduled` | — | — | not rendered (list-only kind) |
| selected (any of the above) | overlay ring 3 px accent | — | `selected-overlay` |

Pane order, top → bottom:

```
selected-overlay > corroborated > reconciled > live > predicted >
user-location > stations > route-shapes > tiles
```

So a `corroborated` marker is never visually buried under a `predicted` one
overlapping it.

### Selected vehicle highlight

`/map/route/[id]?selected=[vehicleId]` reads the query param and renders
the ring overlay on the matching marker. Tapping another marker updates
the query param without navigation, so the back button still returns to
the screen that opened the map.

## 5. Reconciliation gotchas

These are the cases where a simple "match by trip_id then by timing"
breaks down and the bug is easy to re-introduce.

### 5.1 The late-vehicle phantom

Route X every 30 min. Schedule says the next bus is in 2 min. A live GPS
vehicle reports `trip_id` of the *previous* schedule trip — it's 15 min
late. A naive reconciler binds the live vehicle to its reported trip, the
ETA comes out as "departed 25 min ago", and the on-time slot has nothing
visible. The user sees no bus arriving when one is right around the corner.

**Rule.** When the reconciler matches a live vehicle to a finished trip,
the schedule scanner must still emit the unmatched on-time slot as
`predicted`. Net result: two rows — the live late one with its real ETA,
and the on-time predicted one labelled "no live tracking" — so the user
sees both possibilities.

### 5.2 Start-station / terminus binding

Bus is parked at Terminal A at 09:08. Schedule says its next departure
is at 09:15. The bus's `trip_id` is still the 08:45 trip that just ended.
A naive reconciler binds the live vehicle to the 08:45 trip, buckets it
as `departed`, and the user looking for the 09:15 bus sees nothing —
even though they're standing next to it.

**Rule.** When a matched live vehicle is within `2 × proximityAtStationM`
of its current trip's last stop AND the same vehicle id is the
next-trip-from-this-stop candidate within `terminusGraceMin`, upgrade the
binding from `(trip_T, departed)` to `(trip_T_next, at-station)`. This
lives in the reconciler's terminus-grace logic and only fires at start /
end stops, not arbitrary along-route stops.

### 5.3 Tentative multi-candidate matches (Tranzy-only path)

When the live source doesn't carry a canonical `trip_id` (Tranzy doesn't),
two scheduled trips may both fall inside the timing tolerance — typically
the on-time and a late one. Picking only the smaller delta hides the other
from the user.

**Rule.** Emit the picked candidate as `reconciled` with a `tentative`
flag, and keep the rejected candidate as a `predicted` row. The next poll
either confirms the pick (drop the flag) or flips the binding.

This only applies to the Tranzy path. The GTFS-RT path has trip_id and
never goes tentative.

### 5.4 High-frequency routes — require persistence

For routes with median headway ≤ 10 min, a single timing-based observation
isn't enough signal to promote `live` → `reconciled`. Require two
consecutive consistent polls. Implementation: small per-vehicle
observation history in the reconciler.

### 5.5 Direction-id workaround (Cluj feed)

The Cluj GTFS-RT feed lies about `direction_id` — always 0 regardless of
the actual run. The real direction is encoded in the `trip_id` second
segment. The parser normalizes this; see
[live-data-pipeline.md §direction-id resolution](live-data-pipeline.md#direction-id-resolution).

## 6. Things the system deliberately does not do

These came up during design and were rejected. Listed so devs don't
re-litigate them.

- **No dashed / dotted borders to encode "less trustworthy".** Tried, then
  dropped — without a live source to contrast against, dashing every row is
  visual noise. Dimming is driven by [confidence](../concepts/confidence.md) instead.
- **No bearing-based off-route detection.** GTFS-RT carries bearing; not
  consumed yet. Future enhancement — until then, "off-route" is purely a
  shape-distance check.
- **No GPS-jump detection.** Stale GPS and shape distance are the only
  off-route signals. Jumps within tolerance are accepted.
- **No per-feed config overrides.** [`NearyConfig`](../../src/lib/domain/config.ts)
  is global. If a city needs tuned thresholds, that's a structural change.

## 7. Schedule-only kinds and the map

`predicted` and `scheduled` are list-row kinds. The map renders `predicted`
markers (dashed border) but **not** `scheduled` — a vehicle that's
scheduled but no live source has even been polled has no meaningful
position to plot.

If a scheduled trip is active per the calendar and live sources have been
polled with no result, it gets promoted to `predicted` by the
scheduleScanner and at that point appears on the map.
