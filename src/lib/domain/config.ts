// Tunable thresholds for bucketing, prediction, reconciliation. Spec: docs/specs/vehicles-and-views.md.

export interface NearyConfig {
  // ── Bucketing (station view) ───────────────────────────────────────
  /** Meters within which a live vehicle is "physically at" the stop (GPS only — predictions don't qualify). */
  proximityAtStationM: number;
  /** Live vehicle > this far AND off the route shape → `off-route` bucket. */
  offRouteDistanceM: number;
  /** Future ETA threshold separating `arriving` from `incoming`. */
  arrivingThresholdMin: number;
  /** Future ETA ≤ this → `arriving` urgency styling (bold + accent). Above this, neutral. Spec calls this "imminent". */
  imminentEtaThresholdMin: number;
  /** Live vehicle at stop moving faster than this → `departing` (else `at-station`). */
  departingSpeedKmh: number;
  /** Scheduled dwell shorter than this is just passing through, not dwelling. */
  minDwellGapMin: number;

  // ── Live data ───────────────────────────────────────────────────────
  /** GTFS-RT VehiclePositions poll cadence. Upstream feeds typically update every 10–20 s. */
  livePollMs: number;
  /** Per-view device-GPS poll cadence. Matches `livePollMs` so header-dot freshness advances on the same beat as live-vehicle state. */
  gpsPollMs: number;

  // ── Station selection (Stations view) ───────────────────────────────
  /** "Nearby" search radius — only stops within this distance are candidates for the closest + 2nd-closest pair rule. */
  nearbyRadiusM: number;
  /** A 2nd stop joins the closest one ONLY when its distance to the user is within this much of the closest. Keeps the view to the actual pair, never a far-second-best. */
  pairProximityM: number;
  /** Used only when nothing matches the primary radius — surfaces the closest stop within this that carries a favorited route. */
  favoriteFallbackRadiusM: number;
  /** Distance the user must move before the Stations view re-queries AND resets view-only choices (expanded station, route filter). Tuned between typical GPS jitter (~25 m) and slow walking (~1.4 m/s triggers after ~35 s). */
  significantMoveM: number;

  // ── Arrivals window ───────────────────────────────────────────────
  /** How far ahead views ask the worker for arrivals. 18 h from any wall-clock reaches a typical 04:00 GTFS end-of-service; StationCard caps display so the window is cheap. */
  arrivalsWindowMin: number;
}

/** Production defaults. v1 magic numbers ported per spec §7.1. */
export const DEFAULT_CONFIG: NearyConfig = {
  proximityAtStationM: 50,
  offRouteDistanceM: 200,
  arrivingThresholdMin: 1,
  imminentEtaThresholdMin: 10,
  departingSpeedKmh: 5,
  minDwellGapMin: 1,
  livePollMs: 15_000,
  gpsPollMs: 15_000,
  nearbyRadiusM: 500,
  pairProximityM: 100,
  favoriteFallbackRadiusM: 2000,
  significantMoveM: 50,
  arrivalsWindowMin: 24 * 60,
};
