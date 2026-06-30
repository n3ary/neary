/*
 * speedCascade — per-segment speed estimator powering the multi-tier
 * ETA pipeline (item 2 of docs/plan/prediction-v2.md).
 *
 * Cascade (per segment, first tier that returns wins):
 *
 *   1. Vehicle's own reported `speed` — when this is the current
 *      segment or +1 hop AND speed > STOPPED_KMH. Confidence: high.
 *   2. p60 of nearby vehicles' speed (within FLEET_RADIUS_M, same
 *      direction, > STOPPED_KMH) — when segment is 500 m – 2 km out
 *      AND ≥ FLEET_MIN_SAMPLES samples available. Confidence: high
 *      (≥ 5 samples) / medium (≥ 2). Caller passes nearbyVehicles;
 *      empty list = tier 2 skipped (no wiring yet for fleet snapshot).
 *   3. Time-of-day profile from feed config (peak / offpeak / night).
 *      Confidence: medium.
 *   4. City-centre interpolation — only when the feed config carries a
 *      `city_centre` coordinate. Interpolates linearly between
 *      `kmh_min_city_centre` at the centre and `kmh_max_outskirts`
 *      at `centre_radius_km`. Confidence: low.
 *   5. Static `kmh_offpeak` fallback. Confidence: low.
 *
 * Cluj-tuned defaults live in `DEFAULT_FEED_SPEED_CONFIG` (no
 * `city_centre` baked in — that's per-city, opt-in via per-feed
 * override). Per-feed override via the optional `Feed.timing` field
 * (see `data/feeds.ts`) — when neary-gtfs eventually publishes timing
 * to `feeds.json` (option-A future work), this module picks it up
 * with no API change.
 *
 * Pure. No DOM, no stores, no I/O.
 */

import { haversineMeters } from './distance';
import type { Confidence } from './types';
import type { TodBucket } from './timeOfDay';

/** Threshold below which a reported speed reads as "stopped" — a bus
 *  briefly at a red light or stuck in a knot of traffic. Roughly walking
 *  pace; matches v1's filter. Used to exclude stopped vehicles from
 *  tiers 1 and 2 so they don't drag the estimate to zero. */
const STOPPED_KMH = 5;

/** Tier-1 trigger: segment is < this far from the bus, so the bus's
 *  own reported speed is a fair proxy. */
const CASCADE_NEAR_M = 500;

/** Tier-2 trigger: segment is < this far from the bus (and ≥ near
 *  distance). Beyond this we trust the time-of-day profile more than
 *  a local fleet average. */
const CASCADE_MID_M = 2_000;

/** Tier-2 spatial filter: nearby vehicles within this radius of the
 *  bus (haversine). */
const FLEET_RADIUS_M = 1_000;

/** Tier-2 minimum sample count to qualify (after speed + direction
 *  filters). Below this we fall through to tier 3. */
const FLEET_MIN_SAMPLES = 2;

/** Tier-2 sample count for "high" confidence; below = "medium". */
const FLEET_HIGH_CONF_SAMPLES = 5;

export interface FeedSpeedConfig {
  kmh_peak: number;
  kmh_offpeak: number;
  kmh_night: number;
  /** Lower bound used by tier 4's interpolation at the city centre. */
  kmh_min_city_centre: number;
  /** Upper bound used by tier 4's interpolation at the radius edge. */
  kmh_max_outskirts: number;
  /** Radius (km) used by tier 4's linear interpolation. */
  centre_radius_km: number;
  /** When present, tier 4 fires when tier 3 is unavailable. When
   *  absent, the cascade goes 3 → 5 (static). Per-city; not part of
   *  the defaults. */
  city_centre?: { lat: number; lon: number };
}

/** Generic fallback used when a feed's blob has no `_neary_config` table
 *  or no `timing` key. Values approximate a typical European urban bus
 *  network — not tuned to any specific city. Feed-specific values always
 *  win and are written by the neary-gtfs pipeline into `_neary_config`. */
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
  /** Speed in m/s. */
  speedMs: number;
  /** GTFS direction_id; -1 / undefined when not reported. Used to
   *  exclude buses heading the opposite way through the same area. */
  directionId?: 0 | 1 | -1;
}

export interface VehicleObs {
  lat: number;
  lon: number;
  /** Speed in m/s. */
  speedMs: number;
  directionId?: 0 | 1 | -1;
}

export interface SegmentSpeedInputs {
  /** The segment under consideration, as two endpoint coords. Mid-
   *  point is used by tier 4's city-centre distance. */
  segment: { fromLat: number; fromLon: number; toLat: number; toLon: number };
  /** Distance along the shape from the bus's current position to the
   *  *start* of this segment, in metres. 0 means the bus is on this
   *  segment now. Drives tier 1 (< 500 m) and tier 2 (500 m – 2 km). */
  segmentDistanceFromVehicleM: number;
  /** Vehicle's own GPS sample. Undefined for schedule-only callers. */
  vehicle?: VehicleObs;
  /** Other reconciled vehicles' GPS, for tier 2. Empty / undefined
   *  short-circuits tier 2; for now there's no caller wired to provide
   *  this (future enhancement). */
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

  // Tier 1: vehicle's own reported speed when this is the current
  // segment or +1 hop AND the bus is actually moving.
  if (input.vehicle && input.segmentDistanceFromVehicleM < CASCADE_NEAR_M) {
    const kmh = input.vehicle.speedMs * 3.6;
    if (kmh > STOPPED_KMH) {
      return { kmh, source: 'vehicle', confidence: 'high' };
    }
  }

  // Tier 2: p60 of nearby fleet's speeds, filtered by direction +
  // moving + within radius. Fires only when ≥ FLEET_MIN_SAMPLES.
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

  // Tier 3: time-of-day profile from feed config. Always returns when
  // bucket speed is present, which it is for any well-formed config
  // (including the defaults). Tier 4 fires only when tier 3 would
  // produce zero/NaN — a malformed config.
  const todKmh = pickTodSpeed(input.todBucket, cfg);
  if (Number.isFinite(todKmh) && todKmh > 0) {
    return { kmh: todKmh, source: 'tod', confidence: 'medium' };
  }

  // Tier 4: city-centre interpolation. Linear from `kmh_min_city_centre`
  // at the centre to `kmh_max_outskirts` at `centre_radius_km`.
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

  // Tier 5: static fallback. Catastrophic — only fires if config is
  // bizarrely malformed.
  return { kmh: cfg.kmh_offpeak || 20, source: 'static', confidence: 'low' };
}

function pickTodSpeed(bucket: TodBucket, cfg: FeedSpeedConfig): number {
  switch (bucket) {
    case 'peak': return cfg.kmh_peak;
    case 'night': return cfg.kmh_night;
    case 'offpeak': default: return cfg.kmh_offpeak;
  }
}
