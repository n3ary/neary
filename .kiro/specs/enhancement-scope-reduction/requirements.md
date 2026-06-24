# Requirements Document

## Introduction

This feature reduces the scope of vehicle position prediction enhancement from all ~420 vehicles to only the 2-5 vehicles serving routes at the user's nearest station. The goal is to eliminate a 6-second blocking computation during vehicle fetch by deferring enhancement to a scoped prediction cycle that runs immediately after fetch and then every 15 seconds.

## Glossary

- **VehicleService**: The service layer module (`vehicleService.ts`) responsible for fetching raw vehicle data from the Tranzy API and returning vehicle objects to the store.
- **VehicleStore**: The Zustand store (`vehicleStore.ts`) managing vehicle state, including loading, caching, and prediction updates.
- **AutomaticRefreshService**: The singleton service (`automaticRefreshService.ts`) managing vehicle refresh timers and prediction update timers.
- **Enhancement**: The process of applying position predictions to raw vehicle data using `enhanceVehicles()`, producing `EnhancedVehicleData` with interpolated positions and speed predictions.
- **Raw_Vehicle**: A vehicle object from the Tranzy API without position prediction applied, preserving `apiLatitude`, `apiLongitude`, and `apiSpeed` from the original GPS data.
- **Route_Scoped_Vehicles**: The subset of all vehicles whose `route_id` matches one of the route IDs serving the user's nearest station(s).
- **Prediction_Cycle**: A single invocation of `enhanceVehicles()` on Route_Scoped_Vehicles to recalculate position predictions based on the current timestamp.
- **Pending_State**: The visual state of a vehicle card before the first Prediction_Cycle completes, indicating that enhancement is incoming.
- **StationVehicleList**: The UI component that renders `StationVehicle[]` for the user's filtered stations.

## Requirements

### Requirement 1: Instant Vehicle Fetch

**User Story:** As a user, I want vehicles to load instantly when I open the app, so that I see transit data without a 6-second wait.

#### Acceptance Criteria

1. WHEN `VehicleService.getVehicles()` is called, THE VehicleService SHALL return vehicle data without invoking `enhanceVehicles()`.
2. WHEN `VehicleService.getVehicles()` returns vehicles, THE VehicleService SHALL preserve `apiLatitude`, `apiLongitude`, and `apiSpeed` fields from the raw API response on each vehicle object.
3. WHEN `VehicleService.getVehicles()` returns vehicles, THE VehicleService SHALL set `latitude` and `longitude` to the raw API values (no position prediction applied).
4. WHEN `VehicleService.getVehicles()` returns vehicles, THE VehicleService SHALL skip loading trips, stations, shapes, and stop times data that is only needed for enhancement.

### Requirement 2: Route-Scoped Prediction Updates

**User Story:** As a user, I want position predictions computed only for vehicles relevant to my station, so that the app remains responsive.

#### Acceptance Criteria

1. WHEN `VehicleStore.updatePredictions()` is called with a `routeIds` parameter, THE VehicleStore SHALL filter stored vehicles to only those whose `route_id` is present in the provided `routeIds` array.
2. WHEN `VehicleStore.updatePredictions()` enhances Route_Scoped_Vehicles, THE VehicleStore SHALL invoke `enhanceVehicles()` only on the filtered subset of vehicles.
3. WHEN `VehicleStore.updatePredictions()` completes enhancement, THE VehicleStore SHALL merge enhanced vehicles back into the full vehicle array, replacing only the enhanced entries while leaving other vehicles unchanged.
4. WHEN `VehicleStore.updatePredictions()` is called with an empty `routeIds` array, THE VehicleStore SHALL skip enhancement and return without modifying vehicle state.

### Requirement 3: Explicit Route Context Passing

**User Story:** As a developer, I want the prediction scope passed explicitly from the caller, so that the vehicle store does not depend on the station cache store.

#### Acceptance Criteria

1. WHEN the AutomaticRefreshService triggers a Prediction_Cycle, THE AutomaticRefreshService SHALL obtain the current `routeIds` from the station cache and pass them as an explicit parameter to `VehicleStore.updatePredictions()`.
2. THE `VehicleStore.updatePredictions()` method SHALL accept a `routeIds: number[]` parameter defining the prediction scope.
3. IF the AutomaticRefreshService cannot obtain route IDs from the station cache, THEN THE AutomaticRefreshService SHALL pass an empty array, causing predictions to be skipped.

### Requirement 4: Immediate First Prediction Cycle

**User Story:** As a user, I want enhanced predictions to arrive within approximately 1 second after vehicles load, so that the unenhanced window is minimal.

#### Acceptance Criteria

1. WHEN `VehicleStore.loadVehicles()` completes successfully, THE AutomaticRefreshService SHALL trigger one immediate Prediction_Cycle with the current route scope.
2. WHEN the immediate Prediction_Cycle is triggered, THE AutomaticRefreshService SHALL execute the cycle without waiting for the regular 15-second timer interval.
3. WHEN the immediate Prediction_Cycle completes, THE AutomaticRefreshService SHALL continue the regular 15-second prediction timer from that point.

### Requirement 5: Pending State Indicator

**User Story:** As a user, I want a subtle visual indicator on vehicle cards before predictions arrive, so that I know enhancement is incoming.

#### Acceptance Criteria

1. WHILE a vehicle in StationVehicleList has not been enhanced (no Prediction_Cycle has completed for that vehicle), THE StationVehicleList SHALL display a subtle loading/pending indicator on that vehicle's card.
2. WHEN the first Prediction_Cycle completes for a vehicle, THE StationVehicleList SHALL remove the pending indicator from that vehicle's card.
3. THE pending indicator SHALL be non-intrusive and not block the display of the vehicle's raw GPS position or route information.

### Requirement 6: Graceful Unenhanced Display

**User Story:** As a user, I want to see vehicle positions immediately even before enhancement, so that I have useful transit information from the first moment.

#### Acceptance Criteria

1. WHILE a vehicle has not been enhanced, THE StationVehicleList SHALL display the vehicle using its `apiLatitude` and `apiLongitude` as the rendered position.
2. WHILE a vehicle has not been enhanced, THE StationVehicleList SHALL display route name, direction, and other non-prediction data normally.
3. WHEN a vehicle transitions from unenhanced to enhanced state, THE StationVehicleList SHALL update the displayed position to use the enhanced prediction values without a jarring visual transition.

### Requirement 7: Enhancement Function Unchanged

**User Story:** As a developer, I want the `enhanceVehicles()` function to remain unchanged, so that prediction accuracy is preserved.

#### Acceptance Criteria

1. THE `enhanceVehicles()` function signature and internal logic SHALL remain unmodified by this feature.
2. WHEN `enhanceVehicles()` is called with Route_Scoped_Vehicles, THE function SHALL produce identical results as when called with those same vehicles in the previous all-vehicle enhancement approach.
