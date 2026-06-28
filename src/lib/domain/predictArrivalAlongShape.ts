/*
 * predictArrivalAlongShape — multi-tier ETA module, replacing the
 * single-tier `predictEta`. Composes the speed cascade
 * (`estimateSegmentSpeed`) with shape projection so the rendered ETA
 * uses the best-available speed source per segment instead of the
 * vehicle's instantaneous `speedMs`.
 *
 * Today's single-segment cut: speed is asked once for the segment the
 * bus is currently on (driving tier 1 when moving; tier 3 / TOD when
 * not). The full per-segment walk + dwell accumulation is a future
 * refinement once we have a meaningful number of downstream stops on
 * a single ETA query — the Schedule view's "next 10 stops" use case.
 * For the current Stations-board use case (one bus → one stop), the
 * single-segment walk delivers most of the win.
 *
 * Closes item 2 of docs/plan/prediction-v2.md.
 *
 * Pure. No DOM, no stores, no I/O.
 */

import {
  deadReckonGpsAlongShape,
  type GpsObservation,
  type PredictPositionFromGpsContext,
} from './predictPosition';
import {
  distAlongBetween,
  measurePolyline,
  pointAtDistance,
  projectOnPolyline,
  type LatLon,
  type Polyline,
} from './shapeProjection';
import {
  estimateSegmentSpeed,
  type FeedSpeedConfig,
  type NearbyVehicle,
  type SpeedSample,
} from './speedCascade';
import type { TodBucket } from './timeOfDay';
import type { Confidence } from './types';

export interface PredictArrivalInputs {
  /** Latest GPS position of the vehicle. */
  vehiclePos: LatLon;
  /** Stop the user is waiting at. */
  stopPos: LatLon;
  /** Route shape for the vehicle's current trip (worker
   *  `getShapesForTrips`). Must have ≥ 2 points. */
  polyline: Polyline;
  /** Vehicle's reported instant speed in m/s, or null when absent.
   *  Drives cascade tier 1 when present and > 0. */
  vehicleSpeedMs: number | null;
  /** Vehicle's direction_id from GTFS-RT. Used by cascade tier 2 to
   *  filter opposite-direction fleet samples. Undefined / -1 means
   *  unknown. */
  vehicleDirectionId?: 0 | 1 | -1;
  /** TOD bucket for `now`, computed from feed-local minutes via
   *  `clockToBucket`. Drives tier 3. */
  todBucket: TodBucket;
  feedConfig: FeedSpeedConfig;
  /** Other reconciled vehicles for cascade tier 2 (fleet p60).
   *  Optional; empty / undefined short-circuits tier 2. */
  nearbyVehicles?: ReadonlyArray<NearbyVehicle>;
  /** Optional stop distances (same trip shape), used to add dwell
   *  time for intermediate stops between vehicle and target. Distances
   *  must be cumulative metres along `polyline`. */
  dwellStopDistAlongM?: ReadonlyArray<number>;
  /** Flat dwell duration per intermediate stop. Defaults to 20 s. */
  dwellSecondsPerStop?: number;
}

export interface ArrivalPrediction {
  /** Minutes until the vehicle reaches the stop. Negative when the
   *  vehicle has already passed the stop (vehicle distAlong > stop
   *  distAlong). */
  minutes: number;
  /** Absolute distance along the polyline from vehicle to stop, in
   *  metres. */
  distanceMeters: number;
  /** Which cascade tier produced the speed used for this prediction. */
  source: SpeedSample['source'];
  /** Trust grade. Pure function of the cascade tier + perpendicular
   *  projection distances (off-shape projections downgrade). */
  confidence: Confidence;
}

/** Perpendicular projection thresholds (metres). If either the vehicle
 *  or the stop projects further than `MEDIUM_CONF_PERP_M` from the
 *  polyline, confidence is clamped to 'low' regardless of cascade tier
 *  — the inputs aren't trustworthy enough to bank on. */
const HIGH_CONF_PERP_M = 50;
const MEDIUM_CONF_PERP_M = 150;

export function predictArrivalAlongShape(
  input: PredictArrivalInputs,
): ArrivalPrediction {
  const vehProj = projectOnPolyline(input.vehiclePos, input.polyline);
  const stopProj = projectOnPolyline(input.stopPos, input.polyline);

  // Signed: positive when vehicle is before stop, negative when past.
  const signedDistM = distAlongBetween(vehProj, stopProj);
  const absDistM = Math.abs(signedDistM);
  const useSegmentWalk = input.dwellStopDistAlongM != null;
  const dwellStops = input.dwellStopDistAlongM ?? [];

  if (signedDistM <= 0) {
    const sample = estimateSegmentSpeed({
      segment: {
        fromLat: input.vehiclePos.lat, fromLon: input.vehiclePos.lon,
        toLat: input.stopPos.lat, toLon: input.stopPos.lon,
      },
      segmentDistanceFromVehicleM: 0,
      vehicle:
        input.vehicleSpeedMs != null && input.vehicleSpeedMs > 0
          ? {
              lat: input.vehiclePos.lat,
              lon: input.vehiclePos.lon,
              speedMs: input.vehicleSpeedMs,
              directionId: input.vehicleDirectionId,
            }
          : undefined,
      nearbyVehicles: input.nearbyVehicles,
      todBucket: input.todBucket,
      feedConfig: input.feedConfig,
    });
    const minutes = (signedDistM / 1000) / sample.kmh * 60;
    return {
      minutes,
      distanceMeters: absDistM,
      source: sample.source,
      confidence: downgradeForOffShape(sample.confidence, vehProj.perpDistM, stopProj.perpDistM),
    };
  }

  if (!useSegmentWalk) {
    const sample = estimateSegmentSpeed({
      segment: {
        fromLat: input.vehiclePos.lat, fromLon: input.vehiclePos.lon,
        toLat: input.stopPos.lat, toLon: input.stopPos.lon,
      },
      segmentDistanceFromVehicleM: 0,
      vehicle:
        input.vehicleSpeedMs != null && input.vehicleSpeedMs > 0
          ? {
              lat: input.vehiclePos.lat,
              lon: input.vehiclePos.lon,
              speedMs: input.vehicleSpeedMs,
              directionId: input.vehicleDirectionId,
            }
          : undefined,
      nearbyVehicles: input.nearbyVehicles,
      todBucket: input.todBucket,
      feedConfig: input.feedConfig,
    });
    const minutes = (signedDistM / 1000) / sample.kmh * 60;
    return {
      minutes,
      distanceMeters: absDistM,
      source: sample.source,
      confidence: downgradeForOffShape(sample.confidence, vehProj.perpDistM, stopProj.perpDistM),
    };
  }

  const measured = measurePolyline(input.polyline);
  const bounds: number[] = [vehProj.distAlongM];
  for (let i = 1; i < measured.cumDistM.length - 1; i++) {
    const d = measured.cumDistM[i];
    if (d > vehProj.distAlongM && d < stopProj.distAlongM) bounds.push(d);
  }
  bounds.push(stopProj.distAlongM);

  let totalMinutes = 0;
  let firstSource: SpeedSample['source'] = 'tod';
  let aggConfidence: Confidence = 'high';
  let sampled = false;
  for (let i = 0; i < bounds.length - 1; i++) {
    const start = bounds[i];
    const end = bounds[i + 1];
    if (end <= start) continue;
    const from = pointAtDistance(measured, start);
    const to = pointAtDistance(measured, end);
    const sample = estimateSegmentSpeed({
      segment: {
        fromLat: from.lat, fromLon: from.lon,
        toLat: to.lat, toLon: to.lon,
      },
      segmentDistanceFromVehicleM: start - vehProj.distAlongM,
      vehicle:
        input.vehicleSpeedMs != null && input.vehicleSpeedMs > 0
          ? {
              lat: input.vehiclePos.lat,
              lon: input.vehiclePos.lon,
              speedMs: input.vehicleSpeedMs,
              directionId: input.vehicleDirectionId,
            }
          : undefined,
      nearbyVehicles: input.nearbyVehicles,
      todBucket: input.todBucket,
      feedConfig: input.feedConfig,
    });
    if (!sampled) {
      firstSource = sample.source;
      aggConfidence = sample.confidence;
      sampled = true;
    } else {
      aggConfidence = lowerConfidence(aggConfidence, sample.confidence);
    }
    const segDistM = end - start;
    totalMinutes += (segDistM / 1000) / sample.kmh * 60;
  }

  if (dwellStops.length > 0) {
    const dwellSec = input.dwellSecondsPerStop ?? 20;
    if (dwellSec > 0) {
      const n = dwellStops.filter(
        (d) => d > vehProj.distAlongM && d < stopProj.distAlongM,
      ).length;
      totalMinutes += (n * dwellSec) / 60;
    }
  }
  return {
    minutes: totalMinutes,
    distanceMeters: absDistM,
    source: firstSource,
    confidence: downgradeForOffShape(aggConfidence, vehProj.perpDistM, stopProj.perpDistM),
  };
}

function lowerConfidence(a: Confidence, b: Confidence): Confidence {
  const rank: Record<Confidence, number> = { high: 3, medium: 2, low: 1 };
  return rank[a] <= rank[b] ? a : b;
}

function downgradeForOffShape(
  cascadeConf: Confidence,
  vehPerpM: number,
  stopPerpM: number,
): Confidence {
  const worst = Math.max(vehPerpM, stopPerpM);
  if (worst < HIGH_CONF_PERP_M) return cascadeConf;
  if (worst < MEDIUM_CONF_PERP_M) return cascadeConf === 'high' ? 'medium' : cascadeConf;
  return 'low';
}

/**
 * GPS observation → arrival prediction. Single entry point that
 * encapsulates the "dead-reckon raw GPS onto the shape, then run
 * predictArrivalAlongShape" pipeline.
 *
 * DRY contract: any caller that already has a raw GTFS-RT fix MUST
 * call this helper. Do NOT re-implement the dead-reckon-then-predict
 * pattern in views. Doing so risks double extrapolation when callers
 * accidentally feed an already-projected position back into the
 * predictor's dead-reckoner.
 *
 * `positionAtNow` is the dead-reckoned position on the polyline; null
 * when the fix is older than VERY_STALE_MS (caller falls back).
 */
export interface PredictArrivalFromGpsInputs {
  obs: GpsObservation;
  polyline: Polyline;
  stopPos: LatLon;
  nowMs: number;
  todBucket: TodBucket;
  feedConfig: FeedSpeedConfig;
  vehicleDirectionId?: 0 | 1 | -1;
  nearbyVehicles?: ReadonlyArray<NearbyVehicle>;
  dwellStopDistAlongM?: ReadonlyArray<number>;
  dwellSecondsPerStop?: number;
  ctx?: PredictPositionFromGpsContext;
}

export interface PredictArrivalFromGpsResult {
  arrival: ArrivalPrediction;
  positionAtNow: LatLon | null;
}

export function predictArrivalFromGps(
  input: PredictArrivalFromGpsInputs,
): PredictArrivalFromGpsResult {
  const measured = measurePolyline(input.polyline);
  const dr = deadReckonGpsAlongShape(input.obs, measured, input.nowMs, input.ctx);
  const livePos: LatLon = dr?.position ?? { lat: input.obs.lat, lon: input.obs.lon };
  const arrival = predictArrivalAlongShape({
    vehiclePos: livePos,
    stopPos: input.stopPos,
    polyline: input.polyline,
    vehicleSpeedMs: input.obs.speedMs,
    vehicleDirectionId: input.vehicleDirectionId,
    todBucket: input.todBucket,
    feedConfig: input.feedConfig,
    nearbyVehicles: input.nearbyVehicles,
    dwellStopDistAlongM: input.dwellStopDistAlongM,
    dwellSecondsPerStop: input.dwellSecondsPerStop,
  });
  return { arrival, positionAtNow: dr?.position ?? null };
}

