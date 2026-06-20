/**
 * Vehicle Position Prediction Utilities
 * Calculates current vehicle positions based on timestamp age and route movement simulation
 */

import { projectPointToShape } from '../arrival/distanceUtils';
import { calculateDistance } from '../location/distanceUtils';
import { getTripStopSequence } from '../arrival/tripUtils';
import { estimateVehicleProgressWithShape } from '../arrival/vehicleProgressUtils';
import { ARRIVAL_CONFIG } from '../core/constants';
import type {
  TranzyVehicleResponse,
  TranzyStopResponse,
  TranzyStopTimeResponse,
  RouteShape,
  Coordinates,
  ProjectionResult
} from '../../types/arrivalTime';

// ============================================================================
// Core Interfaces
// ============================================================================

export interface PositionPredictionResult {
  predictedPosition: Coordinates;
  metadata: {
    predictedDistance: number; // meters moved
    stationsEncountered: number;
    totalDwellTime: number; // milliseconds
    method: 'route_shape' | 'fallback';
    success: boolean;
    timestampAge: number; // milliseconds
  };
}

export interface MovementSimulation {
  startPosition: Coordinates;
  endPosition: Coordinates;
  distanceTraveled: number;
  stationsEncountered: TranzyStopTimeResponse[];
  totalDwellTime: number; // milliseconds
}

export interface RouteMovementData {
  routeShape: RouteShape;
  tripStopTimes: TranzyStopTimeResponse[];
  stops: TranzyStopResponse[];
  vehicleProjection: ProjectionResult;
}

// ============================================================================
// Main Position Prediction Function
// ============================================================================

/**
 * Calculate predicted vehicle position based on timestamp age and route movement
 * Enhanced to support dynamic speed prediction (Requirements 5.1, 5.3, 5.4)
 */
export function predictVehiclePosition(
  vehicle: TranzyVehicleResponse,
  routeShape?: RouteShape,
  stopTimes?: TranzyStopTimeResponse[],
  stops?: TranzyStopResponse[],
  enhancedVehicle?: { predictionMetadata?: { predictedSpeed?: number } }
): PositionPredictionResult {
  // Parse timestamp and calculate age
  const timestampAge = calculateTimestampAge(vehicle.timestamp);
  
  // If timestamp age is zero or negative, return original coordinates
  if (timestampAge <= 0) {
    return {
      predictedPosition: { lat: vehicle.latitude, lon: vehicle.longitude },
      metadata: {
        predictedDistance: 0,
        stationsEncountered: 0,
        totalDwellTime: 0,
        method: 'fallback',
        success: true,
        timestampAge
      }
    };
  }

  // If no route shape available, fall back to API coordinates
  if (!routeShape || !stopTimes || !stops || !vehicle.trip_id) {
    return {
      predictedPosition: { lat: vehicle.latitude, lon: vehicle.longitude },
      metadata: {
        predictedDistance: 0,
        stationsEncountered: 0,
        totalDwellTime: 0,
        method: 'fallback',
        success: false,
        timestampAge
      }
    };
  }

  try {
    // Get trip stop sequence
    const tripStopTimes = getTripStopSequence(vehicle, stopTimes);
    
    // Project vehicle onto route shape
    const vehiclePosition = { lat: vehicle.latitude, lon: vehicle.longitude };
    const vehicleProjection = projectPointToShape(vehiclePosition, routeShape);
    
    // Check if vehicle is off-route (using same threshold as arrival calculations)
    if (vehicleProjection.distanceToShape > ARRIVAL_CONFIG.OFF_ROUTE_THRESHOLD) {
      return {
        predictedPosition: vehiclePosition,
        metadata: {
          predictedDistance: 0,
          stationsEncountered: 0,
          totalDwellTime: 0,
          method: 'fallback',
          success: false,
          timestampAge
        }
      };
    }

    // Suppress prediction for stationary vehicles at start station (Issue #16)
    // When a vehicle is at the first stop with speed 0, it's likely waiting for
    // scheduled departure — don't predict forward movement.
    if (vehicle.speed === 0 && tripStopTimes.length > 0) {
      const firstStopTime = tripStopTimes[0];
      const firstStop = stops.find(s => s.stop_id === firstStopTime.stop_id);
      if (firstStop) {
        const distanceToFirstStop = calculateDistance(
          vehiclePosition,
          { lat: firstStop.stop_lat, lon: firstStop.stop_lon }
        );
        if (distanceToFirstStop < ARRIVAL_CONFIG.PROXIMITY_THRESHOLD) {
          return {
            predictedPosition: vehiclePosition,
            metadata: {
              predictedDistance: 0,
              stationsEncountered: 0,
              totalDwellTime: 0,
              method: 'route_shape',
              success: true,
              timestampAge,
              isAtStation: true,
              stationId: firstStop.stop_id
            } as any
          };
        }
      }
    }

    // Simulate movement along route with enhanced speed support (Requirements 5.1, 5.3)
    const movementData: RouteMovementData = {
      routeShape,
      tripStopTimes,
      stops,
      vehicleProjection
    };

    const simulation = simulateMovementAlongRoute(timestampAge, movementData, enhancedVehicle);
    
    return {
      predictedPosition: simulation.endPosition,
      metadata: {
        predictedDistance: simulation.distanceTraveled,
        stationsEncountered: simulation.stationsEncountered.length,
        totalDwellTime: simulation.totalDwellTime,
        method: 'route_shape',
        success: true,
        timestampAge
      }
    };

  } catch (error) {
    console.error('Position prediction failed:', error);
    return {
      predictedPosition: { lat: vehicle.latitude, lon: vehicle.longitude },
      metadata: {
        predictedDistance: 0,
        stationsEncountered: 0,
        totalDwellTime: 0,
        method: 'fallback',
        success: false,
        timestampAge
      }
    };
  }
}

// ============================================================================
// Timestamp Processing
// ============================================================================

/**
 * Calculate timestamp age in milliseconds
 * Returns 0 or negative for invalid/future timestamps
 */
export function calculateTimestampAge(timestamp: string): number {
  try {
    const vehicleTime = new Date(timestamp);
    const currentTime = new Date();
    
    // Validate timestamp
    if (isNaN(vehicleTime.getTime())) {
      return 0; // Invalid timestamp
    }
    
    const ageMs = currentTime.getTime() - vehicleTime.getTime();
    return Math.max(0, ageMs); // Never return negative age
  } catch (error) {
    return 0; // Parsing failed
  }
}

// ============================================================================
// Movement Simulation
// ============================================================================

/**
 * Simulate vehicle movement along route shape based on elapsed time
 * Enhanced to support dynamic speed prediction (Requirements 5.1, 5.3, 5.4)
 * Reuses existing vehicle progress estimation for station detection
 */
export function simulateMovementAlongRoute(
  elapsedTimeMs: number,
  movementData: RouteMovementData,
  vehicle?: { predictionMetadata?: { predictedSpeed?: number } }
): MovementSimulation {
  const { routeShape, tripStopTimes, stops, vehicleProjection } = movementData;
  
  // Convert elapsed time to seconds for calculations
  const elapsedTimeSeconds = elapsedTimeMs / 1000;
  
  // Use predicted speed if available, otherwise fall back to average speed (Requirement 5.1)
  const effectiveSpeed = vehicle?.predictionMetadata?.predictedSpeed || ARRIVAL_CONFIG.AVERAGE_SPEED;
  const averageSpeedMs = (effectiveSpeed * 1000) / 3600; // km/h to m/s
  let remainingDistance = elapsedTimeSeconds * averageSpeedMs;
  
  // Start from vehicle's current projected position
  let currentProjection = vehicleProjection;
  let currentPosition = vehicleProjection.closestPoint;
  let totalDistanceTraveled = 0;
  let stationsEncountered: TranzyStopTimeResponse[] = [];
  let totalDwellTime = 0;
  
  // Use existing vehicle progress estimation to find relevant stations
  const vehicleData = {
    latitude: vehicleProjection.closestPoint.lat,
    longitude: vehicleProjection.closestPoint.lon,
    trip_id: tripStopTimes[0]?.trip_id || null
  } as any; // Minimal vehicle data for progress estimation
  
  const progressEstimation = estimateVehicleProgressWithShape(
    vehicleData,
    tripStopTimes,
    stops,
    routeShape
  );
  
  // Find stations ahead based on progress estimation
  const stationsAhead = findStationsAhead(currentProjection, tripStopTimes, stops, routeShape);
  
  // Simulate movement through each station
  for (const stationData of stationsAhead) {
    const { stopTime, stop, projection: stationProjection } = stationData;
    
    // Calculate distance to this station using existing utilities
    const distanceToStation = calculateDistanceToProjection(
      currentProjection,
      stationProjection,
      routeShape
    );
    
    // Check if we have enough remaining distance to reach this station
    if (remainingDistance >= distanceToStation) {
      // Vehicle reaches this station
      remainingDistance -= distanceToStation;
      totalDistanceTraveled += distanceToStation;
      currentProjection = stationProjection;
      currentPosition = stationProjection.closestPoint;
      stationsEncountered.push(stopTime);
      
      // Apply dwell time
      const dwellTimeSeconds = ARRIVAL_CONFIG.DWELL_TIME;
      const dwellTimeMs = dwellTimeSeconds * 1000;
      totalDwellTime += dwellTimeMs;
      
      // Subtract dwell time from remaining movement time
      const remainingTimeAfterDwell = elapsedTimeSeconds - (totalDistanceTraveled / averageSpeedMs) - (totalDwellTime / 1000);
      if (remainingTimeAfterDwell > 0) {
        remainingDistance = remainingTimeAfterDwell * averageSpeedMs;
      } else {
        // Vehicle is still dwelling at this station
        remainingDistance = 0;
        break;
      }
    } else {
      // Vehicle doesn't reach this station, move partway
      const finalPosition = moveAlongShape(
        currentProjection,
        remainingDistance,
        routeShape
      );
      
      totalDistanceTraveled += remainingDistance;
      currentPosition = finalPosition;
      break;
    }
  }
  
  // If no stations ahead or remaining distance after all stations
  if (stationsAhead.length === 0 && remainingDistance > 0) {
    const finalPosition = moveAlongShape(
      currentProjection,
      remainingDistance,
      routeShape
    );
    
    totalDistanceTraveled += remainingDistance;
    currentPosition = finalPosition;
  }
  
  return {
    startPosition: vehicleProjection.closestPoint,
    endPosition: currentPosition,
    distanceTraveled: totalDistanceTraveled,
    stationsEncountered,
    totalDwellTime
  };
}

// ============================================================================
// Route Shape Navigation
// ============================================================================

/**
 * Find stations ahead of current vehicle position along route shape
 */
function findStationsAhead(
  vehicleProjection: ProjectionResult,
  tripStopTimes: TranzyStopTimeResponse[],
  stops: TranzyStopResponse[],
  routeShape: RouteShape
): Array<{ stopTime: TranzyStopTimeResponse; stop: TranzyStopResponse; projection: ProjectionResult }> {
  const stationsAhead: Array<{ stopTime: TranzyStopTimeResponse; stop: TranzyStopResponse; projection: ProjectionResult }> = [];
  
  for (const stopTime of tripStopTimes) {
    const stop = stops.find(s => s.stop_id === stopTime.stop_id);
    if (!stop) continue;
    
    const stopPosition = { lat: stop.stop_lat, lon: stop.stop_lon };
    const stopProjection = projectPointToShape(stopPosition, routeShape);
    
    // Check if this station is ahead of the vehicle
    if (isProjectionAhead(vehicleProjection, stopProjection, routeShape)) {
      stationsAhead.push({ stopTime, stop, projection: stopProjection });
    }
  }
  
  // Sort by distance along route using existing utilities
  stationsAhead.sort((a, b) => {
    const distanceA = calculateDistanceToProjection(vehicleProjection, a.projection, routeShape);
    const distanceB = calculateDistanceToProjection(vehicleProjection, b.projection, routeShape);
    return distanceA - distanceB;
  });
  
  return stationsAhead;
}

/**
 * Check if projection B is ahead of projection A along route shape
 */
function isProjectionAhead(
  projectionA: ProjectionResult,
  projectionB: ProjectionResult,
  routeShape: RouteShape
): boolean {
  // If on different segments, compare segment indices
  if (projectionA.segmentIndex !== projectionB.segmentIndex) {
    return projectionB.segmentIndex > projectionA.segmentIndex;
  }
  
  // If on same segment, compare positions along segment
  return projectionB.positionAlongSegment > projectionA.positionAlongSegment;
}

/**
 * Move a specific distance along route shape from current projection
 */
function moveAlongShape(
  startProjection: ProjectionResult,
  distance: number,
  routeShape: RouteShape
): Coordinates {
  let remainingDistance = distance;
  let currentSegmentIndex = startProjection.segmentIndex;
  let currentPosition = startProjection.positionAlongSegment;
  
  // Move through segments until distance is consumed
  while (remainingDistance > 0 && currentSegmentIndex < routeShape.segments.length) {
    const segment = routeShape.segments[currentSegmentIndex];
    const remainingSegmentDistance = (1 - currentPosition) * segment.distance;
    
    if (remainingDistance <= remainingSegmentDistance) {
      // Final position is within current segment
      const additionalPosition = remainingDistance / segment.distance;
      const finalPosition = currentPosition + additionalPosition;
      
      // Interpolate position along segment
      return interpolateAlongSegment(segment.start, segment.end, finalPosition);
    } else {
      // Move to next segment
      remainingDistance -= remainingSegmentDistance;
      currentSegmentIndex++;
      currentPosition = 0;
    }
  }
  
  // If we've reached the end of the route, return the last point
  const lastSegment = routeShape.segments[routeShape.segments.length - 1];
  return lastSegment.end;
}

/**
 * Calculate distance to a projection along route shape (simplified version)
 * Reuses existing coordinate interpolation logic
 */
function calculateDistanceToProjection(
  fromProjection: ProjectionResult,
  toProjection: ProjectionResult,
  routeShape: RouteShape
): number {
  // If both projections are on the same segment, use simple calculation
  if (fromProjection.segmentIndex === toProjection.segmentIndex) {
    const segment = routeShape.segments[fromProjection.segmentIndex];
    const segmentLength = segment.distance;
    return Math.abs(toProjection.positionAlongSegment - fromProjection.positionAlongSegment) * segmentLength;
  }

  // For different segments, use direct distance as approximation
  // This is simpler than the full route calculation and sufficient for prediction
  return calculateDistance(fromProjection.closestPoint, toProjection.closestPoint);
}

/**
 * Interpolate position along a segment
 */
function interpolateAlongSegment(
  start: Coordinates,
  end: Coordinates,
  position: number // 0-1
): Coordinates {
  const lat = start.lat + (end.lat - start.lat) * position;
  const lon = start.lon + (end.lon - start.lon) * position;
  return { lat, lon };
}