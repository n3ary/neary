# Implementation Plan: Enhancement Scope Reduction

## Overview

Split vehicle fetching from position prediction enhancement. `vehicleService.getVehicles()` becomes a thin fetch layer returning raw GPS data immediately (~200ms), while `updatePredictions(routeIds)` runs asynchronously on only the 2–5 vehicles matching the user's station routes — triggered immediately after fetch and every 15 seconds thereafter. A subtle pending indicator shows on unenhanced vehicle cards.

## Tasks

- [x] 1. Simplify vehicleService.getVehicles()
  - [x] 1.1 Remove enhancement logic from getVehicles
    - Remove `Promise.all` loading of trips, stations, shapes, stopTimes
    - Remove `enhanceVehicles()` call
    - Map raw vehicles to `EnhancedVehicleData` shape with `predictionMetadata: undefined`
    - Set `apiLatitude`, `apiLongitude`, `apiSpeed` from raw values
    - Set `latitude`/`longitude` to raw GPS (no prediction)
    - Remove unused imports (`enhanceVehicles`, `calculateStationDensityCenter`, etc.)
    - _Requirements: 1.1, 1.2, 1.3, 1.4_

  - [ ]* 1.2 Write property test: Raw Field Preservation
    - **Property 1: Raw Field Preservation**
    - Generate random `TranzyVehicleResponse[]`, call the simplified `getVehicles` mapping, verify `apiLatitude === original.latitude`, `apiLongitude === original.longitude`, `apiSpeed === original.speed`, `latitude === original.latitude`, `longitude === original.longitude`, and `predictionMetadata === undefined`
    - File: `src/test/services/vehicleService.property.test.ts`
    - **Validates: Requirements 1.2, 1.3**

  - [ ]* 1.3 Write unit tests for simplified getVehicles
    - Verify `getVehicles` does not call `enhanceVehicles` (mock verification)
    - Verify `getVehicles` does not import or load trips/stations/shapes/stopTimes
    - Verify returned vehicles have `predictionMetadata === undefined`
    - File: `src/test/services/vehicleService.test.ts`
    - _Requirements: 1.1, 1.4_

- [x] 2. Add route-scoped updatePredictions to vehicleStore
  - [x] 2.1 Refactor updatePredictions to accept routeIds parameter
    - Change signature to `updatePredictions: (routeIds: number[]) => Promise<void>`
    - Add early return for empty `routeIds` array
    - Filter vehicles by `route_id` membership in `routeIds` using a `Set`
    - Enhance only the filtered subset via `enhanceVehicles()`
    - Merge enhanced vehicles back into full array by `id`, leaving non-scoped vehicles unchanged
    - Use `lastApiFetch` (not `lastUpdated`) for staleness check
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 3.2_

  - [ ]* 2.2 Write property test: Route-Scoped Filtering
    - **Property 2: Route-Scoped Filtering**
    - Generate random vehicles with various `route_id` values and random `routeIds` subsets. Mock `enhanceVehicles` and verify only matching vehicles are passed to it.
    - File: `src/test/stores/vehicleStore.property.test.ts`
    - **Validates: Requirements 2.1, 2.2**

  - [ ]* 2.3 Write property test: Merge Correctness
    - **Property 3: Merge Correctness**
    - Generate vehicle array and routeIds subset. After mock enhancement, verify scoped vehicles are updated (`predictionMetadata` defined) while non-scoped vehicles are byte-for-byte identical.
    - File: `src/test/stores/vehicleStore.property.test.ts`
    - **Validates: Requirements 2.3, 2.4**

  - [ ]* 2.4 Write unit tests for updatePredictions
    - Test `updatePredictions([])` is a no-op (no state change)
    - Test vehicles with non-matching `route_id` remain unchanged
    - Test merge overwrites only scoped vehicles
    - File: `src/test/stores/vehicleStore.test.ts`
    - _Requirements: 2.4, 2.3_

- [x] 3. Checkpoint
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Wire AutomaticRefreshService to pass route context and trigger immediate prediction
  - [x] 4.1 Add getRouteIdsFromCache helper
    - Add private method `getRouteIdsFromCache(): number[]` that reads the most recent valid entry from `useStationCacheStore`, collects all `routeIds` from its `FilteredStation[]`, deduplicates with `Set`, and returns them
    - Return empty array if cache is stale or empty
    - _Requirements: 3.1, 3.3_

  - [x] 4.2 Update updatePredictionsOnly to pass routeIds
    - Call `this.getRouteIdsFromCache()` and pass result to `vehicleStore.updatePredictions(routeIds)`
    - Update the existing `triggerPredictionUpdate` public method similarly
    - _Requirements: 3.1, 3.2_

  - [x] 4.3 Add immediate prediction trigger after vehicle load
    - Subscribe to vehicle store: detect transition from `loading: true` → `loading: false` with `vehicles.length > 0`
    - On that transition, call `triggerImmediatePrediction()` which stops the current prediction timer, runs one prediction cycle, then restarts the 15s timer
    - Guard against overlapping runs with `isPredicting`
    - Store unsubscribe function for cleanup in `destroy()`
    - _Requirements: 4.1, 4.2, 4.3_

  - [ ]* 4.4 Write unit tests for AutomaticRefreshService changes
    - Test `getRouteIdsFromCache()` returns empty array when cache is stale/empty
    - Test `getRouteIdsFromCache()` returns deduplicated routeIds from valid cache
    - Test immediate prediction trigger fires after `loadVehicles` completes
    - Test timer restarts after immediate prediction cycle
    - File: `src/test/services/automaticRefreshService.test.ts`
    - _Requirements: 3.3, 4.1, 4.2, 4.3_

- [x] 5. Add pending indicator to StationVehicleList
  - [x] 5.1 Add pending enhancement indicator to vehicle cards
    - Detect pending state: `vehicle.predictionMetadata === undefined`
    - Render a small pulsing dot (MUI `Box`, absolutely positioned top-right corner)
    - Use `info.main` color with pulse animation (opacity 0.3–0.6, scale 1–1.2, 1.5s ease-in-out infinite)
    - Ensure existing vehicle data (route, direction, position) continues to display normally
    - Remove indicator once `predictionMetadata` is defined (React re-render handles this)
    - _Requirements: 5.1, 5.2, 5.3, 6.1, 6.2_

  - [ ]* 5.2 Write property test: Pending Indicator State Correlation
    - **Property 4: Pending Indicator State Correlation**
    - Generate vehicle objects with and without `predictionMetadata`. Verify rendering logic correctly shows indicator iff `predictionMetadata === undefined`.
    - File: `src/test/components/features/lists/StationVehicleList.property.test.ts`
    - **Validates: Requirements 5.1, 5.2**

  - [ ]* 5.3 Write unit tests for pending indicator
    - Test indicator renders when `predictionMetadata` is undefined
    - Test indicator does not render when `predictionMetadata` is defined
    - Test vehicle card still shows route name, direction, and position in pending state
    - File: `src/test/components/features/lists/StationVehicleList.test.ts`
    - _Requirements: 5.1, 5.2, 5.3, 6.1, 6.2_

- [x] 6. Ensure smooth transition from unenhanced to enhanced state
  - [x] 6.1 Verify no layout shift on enhancement arrival
    - Confirm the pending indicator is absolutely positioned (no impact on card dimensions)
    - Confirm `latitude`/`longitude` fields used for position display already work with raw values
    - Ensure the position display element doesn't change size or position when prediction data arrives
    - _Requirements: 6.3_

- [x] 7. Final checkpoint
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- The `enhanceVehicles()` function itself is NOT modified (Requirement 7)
- Language: TypeScript (existing codebase)
- Test framework: Vitest + fast-check for property tests
- Tests location: `src/test/` mirroring source path

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "2.1"] },
    { "id": 2, "tasks": ["2.2", "2.3", "2.4"] },
    { "id": 3, "tasks": ["4.1"] },
    { "id": 4, "tasks": ["4.2", "4.3"] },
    { "id": 5, "tasks": ["4.4", "5.1"] },
    { "id": 6, "tasks": ["5.2", "5.3", "6.1"] }
  ]
}
```
