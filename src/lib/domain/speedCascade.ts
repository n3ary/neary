// Multi-tier speed estimator (vehicle > fleet > TOD > city-centre > static). Pure, per-segment, first-tier-wins.

import { haversineMeters } from '@n3ary/gtfs-spec/shape';
import type { Confidence } from './types';
import type { TodBucket } from './timeOfDay';

// Reported speed below this reads as stopped (red light, traffic). Filters out stopped vehicles from tiers 1 & 2 so they don't drag the estimate to zero.
const STOPPED_KMH = 5;

// Tier 1 trigger: bus's own speed is fair proxy when segment is this close.
const CASCADE_NEAR_M = 500;

// Tier 2 trigger: 500 m – 2 km. Beyond this, trust TOD profile over a local fleet average.
const CASCADE_MID_M = 2_000;

// Tier 2 spatial filter (haversine).
const FLEET_RADIUS_M = 1_000;

// Tier 2 minimum samples (after speed + direction filters); below this fall through to tier 3.
const FLEET_MIN_SAMPLES = 2;

// Tier 2 sample count for 'high' confidence; below = 'medium'.
const FLEET_HIGH_CONF_SAMPLES = 5;

export interface FeedSpeedConfig {
  kmh_peak: number;
  kmh_offpeak: number;
  kmh_night: number;
  /** Tier 4 lower bound at the city centre. */
  kmh_min_city_centre: number;
  /** Tier 4 upper bound at `centre_radius_km` edge. */
  kmh_max_outskirts: number;
  /** Tier 4 linear-interpolation radius (km). */
  centre_radius_km: number;
  /** When present, tier 4 fires when tier 3 is unavailable. Per-city; not part of the defaults. */
  city_centre?: { lat: number; lon: number };
}

// Generic European-urban fallback when feed has no _neary_config. Feed-specific values from gtfs pipeline win.
export const DEFAULT_FEED_SPEED_CONFIG: FeedSpeedConfig = {
  kmh_peak: 15,
  kmh_offpeak: 25,
  kmh_night: 30,
  kmh_min_city_centre: 12,
  kmh_max_outskirts: 40,
  centre_radius_km: 5,
};

export interface NearbyVehicle {
  lat: number;
  lon: number;
  /** m/s. */
  speedMs: number;
  /** GTFS direction_id; -1/undefined when not reported. Excludes buses heading the opposite way. */
  directionId?: 0 | 1 | -1;
}

export interface VehicleObs {
  lat: number;
  lon: number;
  /** m/s. */
  speedMs: number;
  directionId?: 0 | 1 | -1;
}

export interface SegmentSpeedInputs {
  /** Mid-point is used by tier 4's city-centre distance. */
  segment: { fromLat: number; fromLon: number; toLat: number; toLon: number };
  /** Distance along the shape from bus position to segment start; 0 = bus is on this segment now. Drives tier 1 (< CASCADE_NEAR_M) and tier 2 (in between). */
  segmentDistanceFromVehicleM: number;
  /** Undefined for schedule-only callers. */
  vehicle?: VehicleObs;
  /** Tier 2 fleet sample. Empty/undefined skips tier 2. */
  nearbyVehicles?: ReadonlyArray<NearbyVehicle>;
  todBucket: TodBucket;
  feedConfig: FeedSpeedConfig;
}

export interface SpeedSample {
  kmh: number;
  source: 'vehicle' | 'fleet' | 'tod' | 'centre' | 'static';
  confidence: Confidence;
}

export function estimateSegmentSpeed(input: SegmentSpeedInputs): SpeedSample {
  const cfg = input.feedConfig;

  // Tier 1: bus's own reported speed (current segment or +1 hop, actually moving)
  if (input.vehicle && input.segmentDistanceFromVehicleM < CASCADE_NEAR_M) {
    const kmh = input.vehicle.speedMs * 3.6;
    if (kmh > STOPPED_KMH) {
      return { kmh, source: 'vehicle', confidence: 'high' };
    }
  }

  // Tier 2: p60 of nearby fleet (filter moving + same direction + within radius)
  if (
    input.vehicle &&
    input.nearbyVehicles && input.nearbyVehicles.length > 0 &&
    input.segmentDistanceFromVehicleM >= CASCADE_NEAR_M &&
    input.segmentDistanceFromVehicleM < CASCADE_MID_M
  ) {
    const own = input.vehicle;
    const samples = input.nearbyVehicles
      .filter((n) => n.speedMs * 3.6 > STOPPED_KMH)
      .filter((n) =>
        own.directionId == null ||
        n.directionId == null ||
        n.directionId === own.directionId,
      )
      .filter((n) => haversineMeters(own.lat, own.lon, n.lat, n.lon) <= FLEET_RADIUS_M)
      .map((n) => n.speedMs * 3.6);
    if (samples.length >= FLEET_MIN_SAMPLES) {
      samples.sort((a, b) => a - b);
      const p60 = samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.6))];
      return {
        kmh: p60,
        source: 'fleet',
        confidence: samples.length >= FLEET_HIGH_CONF_SAMPLES ? 'high' : 'medium',
      };
    }
  }

  // Tier 3: TOD bucket from feed config (always returns for any sane config)
  const todKmh = pickTodSpeed(input.todBucket, cfg);
  if (Number.isFinite(todKmh) && todKmh > 0) {
    return { kmh: todKmh, source: 'tod', confidence: 'medium' };
  }

  // Tier 4: city-centre linear interpolation
  if (cfg.city_centre) {
    const midLat = (input.segment.fromLat + input.segment.toLat) / 2;
    const midLon = (input.segment.fromLon + input.segment.toLon) / 2;
    const distKm =
      haversineMeters(midLat, midLon, cfg.city_centre.lat, cfg.city_centre.lon) / 1000;
    const t = Math.max(0, Math.min(1, distKm / cfg.centre_radius_km));
    const kmh =
      cfg.kmh_min_city_centre + (cfg.kmh_max_outskirts - cfg.kmh_min_city_centre) * t;
    return { kmh, source: 'centre', confidence: 'low' };
  }

  // Tier 5: static fallback (only fires when config is broken)
  return { kmh: cfg.kmh_offpeak || 20, source: 'static', confidence: 'low' };
}

function pickTodSpeed(bucket: TodBucket, cfg: FeedSpeedConfig): number {
  switch (bucket) {
    case 'peak': return cfg.kmh_peak;
    case 'night': return cfg.kmh_night;
    case 'offpeak': default: return cfg.kmh_offpeak;
  }
}
