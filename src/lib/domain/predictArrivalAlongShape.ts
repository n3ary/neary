// Multi-tier ETA: composes speed cascade with shape projection. Single-segment cut today; per-segment walk is a future refinement. Pure.

import {
  deadReckonGpsAlongShape,
  type GpsObservation,
  type PredictPositionFromGpsContext,
} from './predictPosition';
import {
  distAlongBetween,
  haversineMeters,
  measurePolyline,
  pointAtDistance,
  projectOnPolyline,
  type LatLon,
  type Polyline,
} from '@n3ary/gtfs-spec/shape';
import {
  estimateSegmentSpeed,
  type FeedSpeedConfig,
  type NearbyVehicle,
  type SpeedSample,
} from './speedCascade';
import type { TodBucket } from './timeOfDay';
import type { Confidence } from './types';

export interface PredictArrivalInputs {
  vehiclePos: LatLon;
  stopPos: LatLon;
  /** Must have >= 2 points. */
  polyline: Polyline;
  /** Drives cascade tier 1 when present and > 0. */
  vehicleSpeedMs: number | null;
  /** Used by cascade tier 2 to filter opposite-direction fleet samples. -1/undefined = unknown. */
  vehicleDirectionId?: 0 | 1 | -1;
  /** Drives tier 3. Computed from feed-local minutes via `clockToBucket`. */
  todBucket: TodBucket;
  feedConfig: FeedSpeedConfig;
  /** Tier 2 fleet sample. Empty/undefined skips tier 2. */
  nearbyVehicles?: ReadonlyArray<NearbyVehicle>;
  /** Cumulative metres along `polyline`. Enables dwell accumulation in per-segment walk. */
  dwellStopDistAlongM?: ReadonlyArray<number>;
  /** Flat dwell duration per intermediate stop. Defaults to 20 s. */
  dwellSecondsPerStop?: number;
}

export interface ArrivalPrediction {
  /** Negative when vehicle has already passed the stop (distAlong > stop distAlong). */
  minutes: number;
  distanceMeters: number;
  /** Cascade tier that produced the speed. */
  source: SpeedSample['source'];
  /** Cascade confidence, potentially downgraded for off-shape projections. */
  confidence: Confidence;
}

// Off-shape projection thresholds. If either vehicle or stop projects further than MEDIUM_CONF_PERP_M from the polyline, confidence is clamped to 'low' — inputs not trustworthy enough.
const HIGH_CONF_PERP_M = 50;
const MEDIUM_CONF_PERP_M = 150;

// Terminal loops and post-terminus turnarounds can land the projection on a segment whose cumdist diverges from the vehicle's actual position. Above this ratio of |signedDistM| to haversine, the projection has wandered and haversine wins.
const POLYLINE_SAFETY_RATIO = 3;

export function predictArrivalAlongShape(
  input: PredictArrivalInputs,
): ArrivalPrediction {
  const vehProj = projectOnPolyline(input.vehiclePos, input.polyline);
  const stopProj = projectOnPolyline(input.stopPos, input.polyline);

  // signed: positive = vehicle before stop, negative = past
  const signedDistM = distAlongBetween(vehProj, stopProj);
  const absDistM = Math.abs(signedDistM);
  const haversineM = haversineMeters(
    input.vehiclePos.lat, input.vehiclePos.lon,
    input.stopPos.lat, input.stopPos.lon,
  );
  const useSegmentWalk = input.dwellStopDistAlongM != null;
  const dwellStops = input.dwellStopDistAlongM ?? [];

  if (absDistM > haversineM * POLYLINE_SAFETY_RATIO) {
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
    return {
      minutes: (haversineM / 1000) / sample.kmh * 60,
      distanceMeters: haversineM,
      source: sample.source,
      confidence: downgradeForOffShape(sample.confidence, vehProj.perpDistM, stopProj.perpDistM),
    };
  }

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

/** Single entry point for GPS → ETA. Encapsulates the dead-reckon + predict pipeline. Callers with a raw GTFS-RT fix MUST use this to avoid double extrapolation when an already-projected position is fed back into the predictor. */
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
  /** Dead-reckoned position on the polyline; null when the fix is older than VERY_STALE_MS. */
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
