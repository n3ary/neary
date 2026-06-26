/*
 * shapeProjection — pure geometry for projecting GPS points onto a
 * GTFS route shape (polyline) and measuring distance-along-shape.
 *
 * Why: GPS-derived ETA (Phase 5.4) needs to know how far a vehicle
 * is along its route shape so it can divide remaining distance by
 * speed. Treating "distance to stop" as crow-flies haversine is
 * wrong for any route that bends — the bus drives along the polyline,
 * not through buildings.
 *
 * Ported and trimmed from apps/legacy/src/utils/arrival/distanceUtils.ts.
 * The legacy version carried a richer ProjectionResult; here we
 * surface only what the predictor and the off-route detector need.
 *
 * Pure. No DOM, no stores, no I/O.
 */

import { haversineMeters } from './distance';

/** Latitude / longitude pair, in degrees. */
export interface LatLon {
  lat: number;
  lon: number;
}

/** A route shape: ordered list of polyline vertices. Generated from
 *  the SQLite `shapes` table sorted by `shape_pt_sequence`. */
export type Polyline = ReadonlyArray<LatLon>;

export interface PolylineProjection {
  /** Closest point on the polyline (lat / lon). */
  point: LatLon;
  /** Index of the segment the projection landed on. The segment runs
   *  from polyline[segmentIdx] to polyline[segmentIdx + 1]. */
  segmentIdx: number;
  /** Cumulative distance along the polyline from vertex 0 to the
   *  projected point, in meters. */
  distAlongM: number;
  /** Perpendicular distance from the input point to the polyline,
   *  in meters. Use this to gate off-route detection. */
  perpDistM: number;
}

/** Project a single GPS point onto the closest segment of a polyline.
 *
 *  Per-segment math uses an equirectangular linearization around the
 *  segment so we can use plain 2-D vector arithmetic. The earth's
 *  curvature is irrelevant for the few-hundred-meter segments that
 *  GTFS shapes are composed of (typical Cluj route: ~150-500 m per
 *  segment, ~50-150 segments total).
 *
 *  Throws on an empty polyline — callers must validate upstream
 *  (the worker only emits shapes that have ≥2 points). */
export function projectOnPolyline(point: LatLon, polyline: Polyline): PolylineProjection {
  if (polyline.length < 2) {
    throw new Error('projectOnPolyline: polyline must have at least 2 points');
  }

  // Cumulative segment length cache: cumDist[i] = distance from
  // polyline[0] up to polyline[i] along the polyline. Built lazily
  // as we walk so we never iterate twice.
  let bestPerpM = Infinity;
  let bestSegmentIdx = 0;
  let bestPoint: LatLon = polyline[0];
  let bestDistAlongM = 0;
  let runningCumDistM = 0;

  for (let i = 0; i < polyline.length - 1; i++) {
    const a = polyline[i];
    const b = polyline[i + 1];
    const segLenM = haversineMeters(a.lat, a.lon, b.lat, b.lon);
    const { proj, t, perpM } = projectOnSegment(point, a, b, segLenM);
    if (perpM < bestPerpM) {
      bestPerpM = perpM;
      bestSegmentIdx = i;
      bestPoint = proj;
      bestDistAlongM = runningCumDistM + t * segLenM;
    }
    runningCumDistM += segLenM;
  }

  return {
    point: bestPoint,
    segmentIdx: bestSegmentIdx,
    distAlongM: bestDistAlongM,
    perpDistM: bestPerpM,
  };
}

/** Project `p` onto the segment [a, b]. Returns the projected point,
 *  the normalized position along the segment (0 at a, 1 at b, clamped
 *  to [0, 1]), and the perpendicular distance from p to the segment
 *  in meters.
 *
 *  Math: convert to a local equirectangular frame anchored at `a`,
 *  do a plain 2-D dot-product projection, then convert the projected
 *  point back to lat/lon. Distance is computed exactly with
 *  haversine so meter values are not skewed by the linearization. */
function projectOnSegment(
  p: LatLon, a: LatLon, b: LatLon, segLenM: number,
): { proj: LatLon; t: number; perpM: number } {
  // Degenerate zero-length segment: projection is `a` itself.
  if (segLenM === 0) {
    return { proj: a, t: 0, perpM: haversineMeters(p.lat, p.lon, a.lat, a.lon) };
  }
  // Equirectangular: x = lon * cos(midLat), y = lat. Use a's lat
  // as the linearization anchor (segments are short enough that
  // any vertex's latitude is a fine choice).
  const cosLat = Math.cos((a.lat * Math.PI) / 180);
  const ax = a.lon * cosLat;
  const ay = a.lat;
  const bx = b.lon * cosLat;
  const by = b.lat;
  const px = p.lon * cosLat;
  const py = p.lat;
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  // Parametric position along the segment, clamped to [0, 1] so the
  // projection always lands on the segment proper (not its extension).
  const tRaw = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  const t = Math.max(0, Math.min(1, tRaw));
  const projX = ax + t * dx;
  const projY = ay + t * dy;
  const proj: LatLon = { lat: projY, lon: projX / cosLat };
  const perpM = haversineMeters(p.lat, p.lon, proj.lat, proj.lon);
  return { proj, t, perpM };
}

/** Signed distance along the polyline from `from` to `to`, both
 *  expressed as polyline projections. Positive when `to` is further
 *  along the polyline than `from` (i.e. the vehicle is BEFORE the
 *  stop). Negative when the vehicle has already passed the stop. */
export function distAlongBetween(
  from: PolylineProjection, to: PolylineProjection,
): number {
  return to.distAlongM - from.distAlongM;
}
