/**
 * Arrival Status Utilities
 * Pure functions for generating human-friendly arrival messages
 */

import { calculateDistance } from '../location/distanceUtils.ts';
import { ARRIVAL_CONFIG } from '../../utils/core/constants.ts';
import { determineTargetStopRelation } from './arrivalUtils.ts';
import type { TranzyStopResponse, TranzyTripResponse, TranzyStopTimeResponse, ArrivalStatus } from '../../types/arrivalTime.ts';
import type { EnhancedVehicleData } from '../vehicle/vehicleEnhancementUtils.ts';
import type { Coordinates } from '../location/distanceUtils.ts';

/**
 * Generate human-friendly status message from status and time
 */
export function generateStatusMessage(status: ArrivalStatus, estimatedMinutes: number): string {
  switch (status) {
    case 'at_stop':
      return 'At stop';
    case 'in_minutes':
      return generateTimeBasedMessage(estimatedMinutes);
    case 'departed':
      return 'Departed';
    case 'off_route':
      return 'Off route';
  }
}

/**
 * Check if vehicle is within proximity threshold of a stop
 */
function isWithinProximityThreshold(vehiclePosition: Coordinates, targetStop: TranzyStopResponse): boolean {
  const stopPosition = { lat: targetStop.stop_lat, lon: targetStop.stop_lon };
  const distance = calculateDistance(vehiclePosition, stopPosition);
  return distance <= ARRIVAL_CONFIG.PROXIMITY_THRESHOLD;
}

/**
 * Get arrival status based on proximity, speed, and enhanced sequence position
 */
export function getArrivalStatus(
  estimatedMinutes: number,
  vehicle: EnhancedVehicleData,
  targetStop: TranzyStopResponse,
  trips: TranzyTripResponse[],
  stopTimes: TranzyStopTimeResponse[],
  stops: TranzyStopResponse[]
): ArrivalStatus {
  // Check if vehicle is off-route first
  if (!vehicle.route_id) {
    return 'off_route';
  }
  
  // Check if within proximity threshold AND speed is 0
  const vehiclePosition = { lat: vehicle.latitude, lon: vehicle.longitude };
  const speed = vehicle.speed ?? 0;
  
  if (isWithinProximityThreshold(vehiclePosition, targetStop) && speed === 0) {
    return 'at_stop';
  }
  
  // Determine target stop relationship using enhanced trip sequence analysis
  const targetStopRelation = determineTargetStopRelation(vehicle, targetStop, trips, stopTimes, stops);
  
  if (targetStopRelation === 'upcoming') {
    return 'in_minutes';
  } else if (targetStopRelation === 'passed') {
    return 'departed';
  } else {
    // not_in_trip - this should now be rare since filtering is fixed
    return 'off_route';
  }
}

import { CONFIDENCE_LEVELS } from '../core/stringConstants';

/**
 * Generate status message with confidence indicator
 */
export function generateStatusWithConfidence(
  status: ArrivalStatus,
  estimatedMinutes: number,
  confidence: typeof CONFIDENCE_LEVELS[keyof typeof CONFIDENCE_LEVELS]
): string {
  const baseMessage = generateStatusMessage(status, estimatedMinutes);
  return confidence === CONFIDENCE_LEVELS.LOW ? `${baseMessage} (estimated)` : baseMessage;
}

function generateTimeBasedMessage(estimatedMinutes: number): string {
  const roundedMinutes = Math.round(estimatedMinutes);
  return `In ${roundedMinutes} minute${roundedMinutes !== 1 ? 's' : ''}`;
}