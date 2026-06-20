# Terminology

Canonical terms for this codebase. Use these consistently in code, docs, specs, and issues.

## Domain Terms

| Term | Meaning | Code reference |
|------|---------|----------------|
| **Vehicle** | A physical transit unit (bus, tram, trolleybus) with GPS tracking | `TranzyVehicleResponse`, `EnhancedVehicleData` |
| **Route** | A transit line identified by short name (e.g., "24", "1A") | `TranzyRouteResponse` |
| **Station** / **Stop** | A physical location where vehicles stop for passengers | `TranzyStopResponse` |
| **Trip** | A single scheduled journey along a route in one direction | `TranzyTripResponse` |
| **Stop time** | A stop's position in a trip sequence (order, not clock time) | `TranzyStopTimeResponse` |
| **Route shape** | The geographic path a route follows (polyline on map) | `RouteShape` |
| **Agency** | The transit operator (e.g., CTP Cluj) | `TranzyAgencyResponse` |

## Technical Terms

| Term | Meaning | Code reference |
|------|---------|----------------|
| **Position prediction** | Interpolated vehicle position based on elapsed time since last GPS | `EnhancedVehicleData.latitude/longitude` |
| **ETA / Arrival time** | Estimated minutes for a vehicle to reach a station | `ArrivalTimeResult.estimatedMinutes` |
| **Confidence** | Quality indicator for an arrival estimate (high/medium/low) | `ConfidenceLevel` |
| **GPS staleness** | Age of the vehicle's last GPS timestamp | `GPS_DATA_AGE_THRESHOLDS` |
| **API freshness** | Time since last successful API fetch | `API_FETCH_FRESHNESS_THRESHOLDS` |
| **Station role** | Whether a station is start, end, or intermediate for a route | `StationRole` |

## Naming Rules

- Use **vehicle**, not "bus" (vehicles include trams and trolleybuses)
- Use **route**, not "line" or "traseu"
- Use **station**, not "stop" in user-facing text (code uses `stop` for API compatibility)
- Use **trip**, not "journey" or "run"
- Use **position prediction**, not "estimated position" or "interpolated position"
