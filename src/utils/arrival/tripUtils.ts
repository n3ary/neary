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
 * Lazy-built trip_id index for O(1) lookups.
 * Re-uses the same index as long as the input array reference hasn't changed.
 */
let _tripIndex: Map<string, TranzyStopTimeResponse[]> | null = null;
let _tripIndexSource: TranzyStopTimeResponse[] | null = null;

function getTripIndex(stopTimes: TranzyStopTimeResponse[]): Map<string, TranzyStopTimeResponse[]> {
  if (_tripIndex && _tripIndexSource === stopTimes) return _tripIndex;
  
  const idx = new Map<string, TranzyStopTimeResponse[]>();
  for (const st of stopTimes) {
    let arr = idx.get(st.trip_id);
    if (!arr) { arr = []; idx.set(st.trip_id, arr); }
    arr.push(st);
  }
  for (const arr of idx.values()) {
    arr.sort((a, b) => a.stop_sequence - b.stop_sequence);
  }
  _tripIndex = idx;
  _tripIndexSource = stopTimes;
  return idx;
}

/**
 * Get sorted stop times for a vehicle's trip.
 * Uses a lazy-built index for O(1) lookups (the index is built once per
 * stopTimes array reference and reused across all calls in the same render cycle).
 */
export function getTripStopSequence(
  vehicle: TranzyVehicleResponse,
  stopTimes: TranzyStopTimeResponse[]
): TranzyStopTimeResponse[] {
  if (!vehicle.trip_id) return [];
  const idx = getTripIndex(stopTimes);
  return idx.get(vehicle.trip_id) || [];
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
 * Compute stop statuses for a trip in a single pass.
 *
 * Determines the vehicle's current position once, then assigns:
 * - "passed" to stops before the vehicle
 * - "current" to the next stop the vehicle is approaching
 * - "upcoming" to stops after that
 *
 * O(N) where N = stops in the trip (vs the previous O(N²) approach).
 */
export function computeTripStopStatuses(
  vehicle: TranzyVehicleResponse,
  stopTimes: TranzyStopTimeResponse[],
  stops: TranzyStopResponse[],
): { name: string; stopId: number; sequence: number; status: 'passed' | 'current' | 'upcoming' }[] {
  const tripStopTimes = getTripStopSequence(vehicle, stopTimes);
  if (tripStopTimes.length === 0) return [];

  // Determine vehicle's "next stop" sequence number in one shot
  let nextStopSequence = tripStopTimes[0].stop_sequence; // default: start of trip

  // Try proximity check first (is vehicle AT a stop?)
  const PROXIMITY_M = 50;
  const vehiclePos = { lat: vehicle.latitude, lon: vehicle.longitude };
  let resolved = false;

  for (let i = 0; i < tripStopTimes.length; i++) {
    const sd = stops.find(s => s.stop_id === tripStopTimes[i].stop_id);
    if (!sd) continue;
    const dist = calculateDistance(vehiclePos, { lat: sd.stop_lat, lon: sd.stop_lon });
    if (dist <= PROXIMITY_M) {
      // Vehicle is at this stop — next stop is the one after
      nextStopSequence = (i + 1 < tripStopTimes.length)
        ? tripStopTimes[i + 1].stop_sequence
        : tripStopTimes[i].stop_sequence + 1; // past last stop
      resolved = true;
      break;
    }
  }

  // Fallback: segment-based estimation
  if (!resolved) {
    try {
      const progress = estimateVehicleProgressWithStops(vehicle, tripStopTimes, stops);
      if (progress.segmentBetweenStops) {
        nextStopSequence = progress.segmentBetweenStops.nextStop.stop_sequence;
      }
    } catch {
      // Keep default (start of trip)
    }
  }

  // Single pass: assign statuses based on sequence comparison
  return tripStopTimes.map((st) => {
    const stopData = stops.find(s => s.stop_id === st.stop_id);
    let status: 'passed' | 'current' | 'upcoming';
    if (st.stop_sequence < nextStopSequence) {
      status = 'passed';
    } else if (st.stop_sequence === nextStopSequence) {
      status = 'current';
    } else {
      status = 'upcoming';
    }
    return {
      name: stopData?.stop_name || `Stop ${st.stop_id}`,
      stopId: st.stop_id,
      sequence: st.stop_sequence,
      status,
    };
  });
}
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