/*
 * shapeProjection — pure geometry for projecting GPS points onto a
 * GTFS route shape (polyline) and measuring distance-along-shape.
 *
 * Why: GPS-derived ETA needs to know how far a vehicle is along its
 * route shape so it can divide remaining distance by speed. Treating
 * "distance to stop" as crow-flies haversine is wrong for any route
 * that bends — the bus drives along the polyline, not through
 * buildings.
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

/** A polyline with precomputed cumulative distances per vertex. Lets
 *  `pointAtDistance` resolve a position in O(log n) via binary search
 *  instead of re-walking the line each call. Build once when a route
 *  shape loads; reuse across every render tick. */
export interface MeasuredPolyline {
  points: Polyline;
  /** `cumDistM[i]` = distance from points[0] to points[i] along the
   *  polyline, in meters. `cumDistM[0]` is 0; `cumDistM[length-1]`
   *  equals `totalDistM`. */
  cumDistM: number[];
  totalDistM: number;
}

/** Build the cumulative-distance index for a polyline. O(n). */
export function measurePolyline(polyline: Polyline): MeasuredPolyline {
  const n = polyline.length;
  const cumDistM = new Array<number>(n);
  if (n === 0) return { points: polyline, cumDistM, totalDistM: 0 };
  cumDistM[0] = 0;
  for (let i = 1; i < n; i++) {
    cumDistM[i] = cumDistM[i - 1] + haversineMeters(
      polyline[i - 1].lat, polyline[i - 1].lon,
      polyline[i].lat,     polyline[i].lon,
    );
  }
  return { points: polyline, cumDistM, totalDistM: cumDistM[n - 1] };
}

/** Resolve a cumulative-distance value back to a lat/lon on the
 *  polyline. Clamps to the endpoints when out of range. O(log n)
 *  thanks to the precomputed `cumDistM`. */
export function pointAtDistance(measured: MeasuredPolyline, distM: number): LatLon {
  const { points, cumDistM, totalDistM } = measured;
  if (points.length === 0) {
    throw new Error('pointAtDistance: empty polyline');
  }
  if (points.length === 1 || distM <= 0) return points[0];
  if (distM >= totalDistM) return points[points.length - 1];
  // Binary search for the segment containing distM:
  //   cumDistM[lo] <= distM < cumDistM[lo + 1]
  let lo = 0;
  let hi = cumDistM.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >>> 1;
    if (cumDistM[mid] <= distM) lo = mid;
    else hi = mid;
  }
  const a = points[lo];
  const b = points[lo + 1];
  const segLen = cumDistM[lo + 1] - cumDistM[lo];
  const t = segLen > 0 ? (distM - cumDistM[lo]) / segLen : 0;
  return {
    lat: a.lat + (b.lat - a.lat) * t,
    lon: a.lon + (b.lon - a.lon) * t,
  };
}

/** Initial great-circle bearing from point `a` to point `b`, in
 *  degrees CW from North (0 = North, 90 = East). Used to point the
 *  map's direction-of-travel cue at the overall origin→terminus
 *  vector, which reads more usefully than the very-first shape
 *  segment (that segment often jitters out of the terminal apron
 *  before the route settles on its real heading). */
export function bearingBetween(a: LatLon, b: LatLon): number {
  const toRad = Math.PI / 180;
  const f1 = a.lat * toRad;
  const f2 = b.lat * toRad;
  const dl = (b.lon - a.lon) * toRad;
  const y = Math.sin(dl) * Math.cos(f2);
  const x = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

/** Bearing in degrees (0 = North, 90 = East) of the segment that
 *  contains the given cumulative distance. Used to rotate direction
 *  arrows on the route map so they point the way the vehicle is
 *  travelling. */
export function bearingAtDistance(measured: MeasuredPolyline, distM: number): number {
  const { points, cumDistM, totalDistM } = measured;
  if (points.length < 2) return 0;
  const clamped = Math.max(0, Math.min(totalDistM, distM));
  let lo = 0;
  let hi = cumDistM.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >>> 1;
    if (cumDistM[mid] <= clamped) lo = mid;
    else hi = mid;
  }
  return bearingBetween(points[lo], points[lo + 1] ?? points[lo]);
}
