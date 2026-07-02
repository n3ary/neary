# Terminology

Canonical names. Use these in code and docs.

## Domain

| Use | Don't use | Why |
|---|---|---|
| **vehicle** | bus, tram, trolley | We render mixed modes; "vehicle" is mode-agnostic |
| **route** | line, service | GTFS canonical |
| **station** | stop (in user-facing copy) | Friendlier; internal/GTFS code can use `stop` |
| **trip** | journey, run | GTFS canonical |
| **headsign** | destination, terminus | GTFS canonical; what the front sign reads |
| **direction** | inbound/outbound, dir | GTFS `direction_id` (0 or 1) |
| **circular route** | loop, ring | Route whose first and last stops resolve to the same physical location (identical `stop_id`, or within ~200 m). Direction-of-travel cues are suppressed for circular routes since origin ≈ terminus |
| **feed** | agency (in v2 UX) | A feed may carry multiple agencies; see [feeds.md](feeds.md) |
| **ETA** | arrival time, time-to-arrive | "ETA" is short and unambiguous |
| **bucket** | status, state | Specific term for station-view arrival classification |

## Technical

| Use | Don't use |
|---|---|
| GTFS-RT | realtime feed, real-time |
| reconciler | matcher, joiner |
| confidence | trust, accuracy |
| GPS staleness | location age |
| live source | provider, feed (when talking about live-data URLs) |
| `isFirstStop` / `isLastStop` | `isAtTripStart` / `isAtTripEnd` (the row's POV, not the vehicle's) |
| `tripPhase` (`next` / `last` / `on-route` / `later`) | ad-hoc "which trip is upcoming" predicates — see [vehicle.md](vehicle.md#trip-phase) |

## Anti-vocabulary (do not introduce)

- "ghost" — replaced by `kind: "scheduled"` (with `schedule.tripPhase` for the running-but-no-live case), see [vehicle.md](vehicle.md).
- "agency picker" — say "feed picker".
