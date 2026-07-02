# Vehicle

Every row in a station/schedule/map view is one `Vehicle`. The `kind`
field is a discriminated union encoding **how we know where it is**.

Source: [src/lib/domain/types.ts](../../src/lib/domain/types.ts) is authoritative.

## Kinds

| Kind | Meaning |
|---|---|
| `scheduled` | In the schedule. May carry an interpolated position (`source: 'predicted-from-schedule'`) when the trip is currently running per `schedule.tripPhase` (`last` / `on-route`) but no live source has matched it. |
| `gps-only` | Live GPS, no schedule match (rare — typical when the live feed's `trip_id` doesn't resolve in the static schedule). |
| `tracked` | Schedule + 1 live source matched. |
| `verified` | Schedule + 2+ live sources agree. Currently unreachable in production because only one live source (GTFS-RT) is wired; kept in the type so multi-source (see [../specs/multi-source-live-data.md](../specs/multi-source-live-data.md)) can promote to it. |

Reads as a ladder of certainty: `scheduled < gps-only < tracked < verified`.

The visual taxonomy and bucket interaction live in [specs/vehicles-and-views.md](../specs/vehicles-and-views.md).

## Two axes

The `kind` discriminator answers **where our position information comes
from**. It is orthogonal to `schedule.tripPhase` (Axis A, see "Trip
phase" below), which answers **where the trip sits on its route's
daily timetable relative to `now`**. "Should this trip be running
right now?" is a phase question (`tripPhase === 'last' || 'on-route'`),
not a `kind` question — the same trip can be `scheduled` (no live
match yet, interpolated position) or `tracked`/`verified` (live match)
while in either phase.

## Why a discriminated union

- One component per kind, used identically in list / schedule / map.
- Schedule-only detection lives in the reconciler, not in JSX.
- The UI never has to guess what data is present — the type system enforces it.

## Per-row metadata

Each entry also carries:

- `confidence: 'high' | 'medium' | 'low'` → see [confidence.md](confidence.md).
- `liveSources: LiveSource[]` (when the kind has live data) → records which feeds confirm it.
- `schedule.isFirstStop` → this row's target stop IS the trip's first stop (origin). Named from the row's POV, not the vehicle's: the row represents the origin, the bus itself may be anywhere. Schedule is authoritative when true (the bus hasn't started moving yet).
- `schedule.isLastStop` → this row's target stop IS the trip's last stop (terminus). Suppresses the upcoming-stops expansion.
- `schedule.tripPhase` → see "Trip phase" below.

## Trip phase

`schedule.tripPhase` classifies how this trip's origin departure
relates to `now` on its route:

| Value | Meaning |
|---|---|
| `next` | The next departure on this route that hasn't left yet |
| `last` | The most recent departure that has left and is still running |
| `on-route` | An earlier departure that has left and is still running (not the most recent) |
| `later` | Any future origin departure that is not `next` |

Exactly one `next` and at most one `last` per route. Tie-break on equal
departure times by `tripId` lexicographic order. Set on every emitted
row, not only origin rows — `tripPhase` is a property of the trip's
lifecycle, independent of which stop's row we're looking at. UI
consumers (drop-off filter at terminus, action-button gates at any
stop) need the phase at midpoints too, so we classify uniformly.

The role is recomputed on every snapshot regeneration because it is a
function of `now`: at 14:59 a trip is `next`, at 15:00 (once its
scheduled departure passes) it becomes `last`, the previous `last`
demotes to `on-route`, and the next `later` row promotes to `next`.

Orthogonal to `kind` and to [arrival-buckets](arrival-buckets.md). A
`next` row can carry GPS (`kind: 'tracked'`) when the bus is at
the depot already broadcasting; `last` and `on-route` rows almost
always do.

## Visual rendering — kind dot

The `VehicleCard` shows a small dot on the far right encoding `kind`
in two colors: green for live-backed (`gps-only` / `tracked` /
`verified`), grey for `scheduled`. The tooltip carries the specific
kind.

The dot is **hidden** when `kind === 'scheduled' && tripPhase === 'later'`.
Those rows are future-but-not-next — the grey dot adds nothing the
rider doesn't already know from the row being on the schedule.
`next` / `last` / `on-route` rows keep the dot because the data-source
distinction (parked-and-on-schedule vs running-without-GPS) is
informative there.

The **upcoming-stops expansion** is also hidden on `later` rows. A
`later` row always sits below a `next` row of the same route on the
station board, and the `next` row already exposes the same stop list
(the trip's path is identical). Showing the chevron on every `later`
row duplicates an affordance the rider already has one row up.
