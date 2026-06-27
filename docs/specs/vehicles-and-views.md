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
| Stations card route badge | route id | `/schedule/route/[id]_[direction]` (path-based; the picked direction is encoded as `_0` or `_1`) |
| Stations card map icon | trip id | `/map/route/[id]_[direction]/[tripId]` (selected trip is a path segment) |
| Favorites saved route | schedule icon | `/schedule/route/[id]_0` |
| Favorites saved route | map icon | `/map/route/[id]_0` |
| Map vehicle marker | marker | navigates to `/map/route/[id]_[direction]/[tripId]` with the new trip in the path |

The favorites card body is intentionally not tappable — the badge is
identity-only (mirrors VehicleCard). Navigation goes through the dedicated
map / schedule icon buttons, so a quick tap on the colored badge doesn't
lead anywhere unexpected.

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

The map ([src/routes/map/route/[id]/[[selected]]/+page.svelte](../../src/routes/map/route/%5Bid%5D/%5B%5Bselected%5D%5D/+page.svelte))
uses a simpler 2-state marker model than the full `Vehicle.kind` union:

| Marker state | When | Visual |
|---|---|---|
| **en-route** | trip is in transit (predicted from shape or live GPS) | solid route-color badge with the route shortName |
| **scheduled** | the soonest not-yet-departed trip on the route (`status === 'before'` or `'at-origin'`) | white badge, route-colored border + text (outlined) |

On top of the badge fill, a ring conveys live-data state:

| Ring | Meaning |
|---|---|
| white (default) | no live GPS, or live fix expired |
| green | live GPS, fresh fix |
| yellow | live GPS, stale fix |
| white inner + dark outer | the currently selected vehicle |

Fresh vs stale vs expired thresholds live in [`predictPosition.ts`](../../src/lib/domain/predictPosition.ts) (`predictPositionFromGps`).

### One scheduled marker, not many

Multiple upcoming trips can be "before" or "at-origin" at the same time;
rendering all of them would stack bubbles on top of each other at the
origin stop. The page sorts trips by `tripStartMin` and keeps the
**soonest one only**. Trips already finished (`status === 'after'`) are
dropped entirely.

### Leaflet panes

The page uses Leaflet panes to control z-order without relying on render
order:

```
nearyVehicles (z=620) > markerPane (z=600, stops) > overlayPane (route shape) > tilePane
```

So vehicle badges always render above stop markers; stop markers always
render above the route polyline.

### Selected vehicle highlight

The selected trip is encoded as a **path segment**, not a query param:
`/map/route/[id]/[[selected]]`. Tapping another marker navigates to the new
path, so the back button returns to the screen that opened the map.

## 5. Reconciliation gotchas

These are the cases where a simple "match by trip_id then by timing"
breaks down and the bug is easy to re-introduce.

> [!IMPORTANT]
> Only §5.5 (Cluj direction-id workaround) is wired up; §5.1–5.4 are
> aspirational design tracked in [../plan/prediction-v2.md](../plan/prediction-v2.md)
> and [../plan/tranzy-integration.md](../plan/tranzy-integration.md).
> The rules below are the **contract** the reconciler must satisfy when
> live reconciliation lands — if a future PR ships live matching without
> these, you get the bugs listed.

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

`scheduled` and `predicted` are list-row kinds for the station and
schedule views — the discriminated union encodes how we know what we
know about the vehicle.

The **map** doesn't consume the full union; it has its own simpler 2-state
model (see §4). What matters at the spec level:

- The **soonest upcoming scheduled trip** for the route is rendered at the
  origin as an outlined white badge. Later upcoming trips are not
  rendered (would stack at origin).
- En-route trips render with their predicted position whether or not a
  live source has been polled. Without live GPS the position comes from
  schedule interpolation along the shape.
- Finished trips (past terminus) are dropped.

The richer 5-kind taxonomy (`corroborated` / `reconciled` / `live` /
`predicted` / `scheduled`) is consumed by the **list** views (Stations,
Schedule) where the kind drives row dimming and confidence pips. The
map deliberately doesn't try to encode all five at once — the badge
space is too small and the rider only needs to know "waiting at origin"
vs "already moving".
