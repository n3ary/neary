/**
 * Trip Parsing Utilities
 * Shared logic for parsing trip sequences and stop relationships
 */

import { estimateVehicleProgressWithStops } from './vehicleProgressUtils';
import { calculateDistance } from '../location/distanceUtils';
import type {
  TranzyVehicleResponse,
  TranzyStopResponse,
  TranzyStopTimeResponse
} from '../../types/arrivalTime.ts';

/**
 * Get sorted stop times for a vehicle's trip
 */
export function getTripStopSequence(
  vehicle: TranzyVehicleResponse,
  stopTimes: TranzyStopTimeResponse[]
): TranzyStopTimeResponse[] {
  if (!vehicle.trip_id) return [];
  
  return stopTimes
    .filter(st => st.trip_id === vehicle.trip_id)
    .sort((a, b) => a.stop_sequence - b.stop_sequence);
}

/**
 * Find a stop's position in the trip sequence
 */
export function findStopInSequence(
  stopId: number,
  tripStopTimes: TranzyStopTimeResponse[]
): { index: number; stopTime: TranzyStopTimeResponse | null } {
  const index = tripStopTimes.findIndex(st => st.stop_id === stopId);
  const stopTime = index >= 0 ? tripStopTimes[index] : null;
  
  return { index, stopTime };
}

/**
 * Get intermediate stop data between vehicle and target stop
 * Uses existing vehicle progress estimation to determine actual position
 */
export function getIntermediateStopData(
  vehicle: TranzyVehicleResponse,
  targetStop: TranzyStopResponse,
  stopTimes: TranzyStopTimeResponse[],
  stops: TranzyStopResponse[]
): {
  coordinates: { lat: number; lon: number }[];
  count: number;
  tripStopTimes: TranzyStopTimeResponse[];
} {
  const tripStopTimes = getTripStopSequence(vehicle, stopTimes);
  const { index: targetStopIndex } = findStopInSequence(targetStop.stop_id, tripStopTimes);
  
  if (targetStopIndex === -1) {
    return {
      coordinates: [],
      count: 0,
      tripStopTimes
    };
  }

  // Use existing vehicle progress estimation to find where vehicle actually is
  let vehicleCurrentStopIndex = 0;
  let resolved = false;

  // FIRST: if the vehicle is AT a stop (within proximity), use the NEXT stop as
  // the start of the remaining intermediates — mirroring getNextStationForVehicle.
  // Without this, a vehicle stopped at a stop yields no "between stops" segment
  // and we'd fall back to index 0 (trip start), counting EVERY stop from the
  // start as intermediate and inflating dwell time (Issue: late-route bus at a
  // stop showed a far-too-large ETA).
  const STATION_PROXIMITY_THRESHOLD = 50; // meters
  const vehiclePos = { lat: vehicle.latitude, lon: vehicle.longitude };
  for (let i = 0; i < tripStopTimes.length; i++) {
    const sd = stops.find(s => s.stop_id === tripStopTimes[i].stop_id);
    if (!sd) continue;
    if (calculateDistance(vehiclePos, { lat: sd.stop_lat, lon: sd.stop_lon }) <= STATION_PROXIMITY_THRESHOLD) {
      vehicleCurrentStopIndex = i + 1; // remaining intermediates start after this stop
      resolved = true;
      break;
    }
  }

  // SECOND: not at a stop — use segment-based progress (between two stops).
  if (!resolved) {
    try {
      const vehicleProgress = estimateVehicleProgressWithStops(vehicle, tripStopTimes, stops);

      if (vehicleProgress.segmentBetweenStops) {
        // Vehicle is between two stops - find the index of the next stop
        const nextStopSequence = vehicleProgress.segmentBetweenStops.nextStop.stop_sequence;

        // Find the index of this next stop in our trip sequence
        const nextStopIndex = tripStopTimes.findIndex(st => st.stop_sequence === nextStopSequence);
        if (nextStopIndex !== -1) {
          vehicleCurrentStopIndex = nextStopIndex;
        }
      }
    } catch (error) {
      // Fallback: assume vehicle is at beginning of trip
      console.warn('Could not determine vehicle position, using trip start as fallback');
      vehicleCurrentStopIndex = 0;
    }
  }

  // Get intermediate stops between vehicle's current position and target
  const startIndex = Math.min(vehicleCurrentStopIndex, targetStopIndex);
  const endIndex = targetStopIndex;
  
  const intermediateStopTimes = tripStopTimes.slice(startIndex, endIndex);
  
  const coordinates = intermediateStopTimes.map(st => {
    const stopData = stops.find(s => s.stop_id === st.stop_id);
    return stopData ? { lat: stopData.stop_lat, lon: stopData.stop_lon } : { lat: 0, lon: 0 };
  });

  return {
    coordinates,
    count: Math.max(0, endIndex - startIndex),
    tripStopTimes
  };
}