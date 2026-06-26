/*
 * Predict a vehicle's current position from its trip's stop timeline.
 *
 * Two flavors:
 *
 *   `predictPosition(stops, nowMin)` — straight-line interpolation
 *   between consecutive stops. Falls back well when the feed doesn't
 *   carry shapes.txt.
 *
 *   `predictPositionOnShape(plan, nowMin)` — interpolates along the
 *   route's polyline using cumulative distances, so the marker
 *   follows the road instead of cutting through buildings. Use
 *   whenever a shape is available; build the `TripShapePlan` once
 *   per trip+shape pair with `buildTripShapePlan` and reuse across
 *   every render tick.
 *
 * Status values let the UI hide / dim a vehicle without re-deriving:
 *   - 'before':   nowMin < origin departure — bus hasn't started yet.
 *   - 'at-origin': nowMin in [origin - imminentMin, origin departure]
 *                  — coming up at the start station.
 *   - 'active':   between origin departure and terminus arrival.
 *   - 'after':    past terminus.
 *
 * Live GPS hasn't been wired through this helper yet — when it is,
 * the reconciler will short-circuit prediction with the GPS fix.
 */

import {
  measurePolyline,
  pointAtDistance,
  projectOnPolyline,
  type LatLon,
  type MeasuredPolyline,
  type Polyline,
} from './shapeProjection';

export interface PredictStop {
  lat: number;
  lon: number;
  /** Minutes since local midnight (GTFS extended time allowed,
   *  i.e. 24h+ for past-midnight night routes). */
  arrivalMin: number;
}

export type TripStatus = 'before' | 'at-origin' | 'active' | 'after';

export interface PredictedPosition {
  lat: number;
  lon: number;
  status: TripStatus;
}

/** Default 'imminent' window — a vehicle inside this many minutes of
 *  its origin departure counts as 'at-origin' rather than 'before'.
 *  Matches the existing UI convention of "imminentEtaThresholdMin". */
export const DEFAULT_IMMINENT_MIN = 5;

/**
 * Pick the position to render for a vehicle on a known trip.
 * Returns `null` only when the trip has no stops at all — every
 * other case yields a position + status.
 *
 * Straight-line variant: the position between two stops lies on the
 * direct segment between their coordinates. Acceptable when no shape
 * is available; prefer `predictPositionOnShape` when the feed does
 * have shapes.txt for the route.
 */
export function predictPosition(
  stops: readonly PredictStop[],
  nowMin: number,
  imminentMin: number = DEFAULT_IMMINENT_MIN,
): PredictedPosition | null {
  if (stops.length === 0) return null;
  const origin = stops[0];
  const terminus = stops[stops.length - 1];

  if (nowMin < origin.arrivalMin) {
    const status: TripStatus =
      origin.arrivalMin - nowMin <= imminentMin ? 'at-origin' : 'before';
    return { lat: origin.lat, lon: origin.lon, status };
  }
  if (nowMin >= terminus.arrivalMin) {
    return { lat: terminus.lat, lon: terminus.lon, status: 'after' };
  }

  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i];
    const b = stops[i + 1];
    if (nowMin >= a.arrivalMin && nowMin < b.arrivalMin) {
      const span = b.arrivalMin - a.arrivalMin;
      const t = span > 0 ? (nowMin - a.arrivalMin) / span : 0;
      return {
        lat: a.lat + (b.lat - a.lat) * t,
        lon: a.lon + (b.lon - a.lon) * t,
        status: 'active',
      };
    }
  }
  return { lat: terminus.lat, lon: terminus.lon, status: 'active' };
}

/** Precomputed per-trip data used by `predictPositionOnShape`.
 *  Build once when the route's shape + stops arrive (mount-time);
 *  the only per-tick work is then a binary search + an interpolation. */
export interface TripShapePlan {
  /** Polyline + cumulative distances. */
  measured: MeasuredPolyline;
  /** One entry per stop in `stops`, same length and order.
   *  `arrivalMin` carries the schedule; `distAlongM` is the stop's
   *  position projected onto the shape. */
  legs: Array<{ arrivalMin: number; distAlongM: number }>;
}

/** Build a `TripShapePlan` by projecting each stop onto the shape's
 *  polyline. O(stops × shape segments). Run once per trip+shape.
 *  Returns `null` when no usable shape exists — caller should fall
 *  back to `predictPosition`. */
export function buildTripShapePlan(
  stops: readonly PredictStop[],
  shape: Polyline,
): TripShapePlan | null {
  if (stops.length === 0 || shape.length < 2) return null;
  const measured = measurePolyline(shape);
  const legs = stops.map((s) => {
    const proj = projectOnPolyline({ lat: s.lat, lon: s.lon } as LatLon, shape);
    return { arrivalMin: s.arrivalMin, distAlongM: proj.distAlongM };
  });
  // Stops projected onto a doubled-back shape (rare but possible
  // when an operator publishes the same trace for both directions)
  // can land out of order. Ignore that here — the time-based bracket
  // below uses arrivalMin, not distAlongM, so a non-monotonic legs[]
  // array still produces sensible interpolation.
  return { measured, legs };
}

/** Shape-aware variant of `predictPosition`. Same status semantics. */
export function predictPositionOnShape(
  plan: TripShapePlan,
  nowMin: number,
  imminentMin: number = DEFAULT_IMMINENT_MIN,
): PredictedPosition | null {
  const { legs, measured } = plan;
  if (legs.length === 0) return null;
  const origin = legs[0];
  const terminus = legs[legs.length - 1];

  const originPoint = pointAtDistance(measured, origin.distAlongM);
  if (nowMin < origin.arrivalMin) {
    const status: TripStatus =
      origin.arrivalMin - nowMin <= imminentMin ? 'at-origin' : 'before';
    return { lat: originPoint.lat, lon: originPoint.lon, status };
  }
  if (nowMin >= terminus.arrivalMin) {
    const p = pointAtDistance(measured, terminus.distAlongM);
    return { lat: p.lat, lon: p.lon, status: 'after' };
  }

  for (let i = 0; i < legs.length - 1; i++) {
    const a = legs[i];
    const b = legs[i + 1];
    if (nowMin >= a.arrivalMin && nowMin < b.arrivalMin) {
      const span = b.arrivalMin - a.arrivalMin;
      const t = span > 0 ? (nowMin - a.arrivalMin) / span : 0;
      const distAlongM = a.distAlongM + (b.distAlongM - a.distAlongM) * t;
      const p = pointAtDistance(measured, distAlongM);
      return { lat: p.lat, lon: p.lon, status: 'active' };
    }
  }
  const p = pointAtDistance(measured, terminus.distAlongM);
  return { lat: p.lat, lon: p.lon, status: 'active' };
}
