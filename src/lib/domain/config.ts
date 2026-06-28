/*
 * NearyConfig — single source of truth for all tunable thresholds used by
 * the bucketing, prediction, and reconciliation layers.
 * Spec: docs/specs/vehicles-and-views.md.
 *
 * For now everyone reads `DEFAULT_CONFIG`. A future advanced-settings
 * view will be able to override individual fields per session.
 * Keeping all magic numbers behind one type means we never have to
 * grep the codebase to tune the app.
 */

export interface NearyConfig {
  // ── Bucketing (station view) ───────────────────────────────────────
  /** A vehicle within this many meters of the stop is "physically at" it.
   *  Only meaningful for live vehicles (we trust GPS, not predictions). */
  proximityAtStationM: number;
  /** Live vehicle that's > this far from the stop AND off the route shape
   *  is bucketed off-route. */
  offRouteDistanceM: number;
  /** Future ETA threshold separating "arriving" from "incoming". */
  arrivingThresholdMin: number;
  /** A future ETA at or below this threshold is rendered with the same
   *  urgency styling as the `arriving` bucket (bold + accent color). Above
   *  this, the row stays neutral. Spec §3 calls this "imminent". */
  imminentEtaThresholdMin: number;
  /** A live vehicle at the stop moving faster than this is "departing"
   *  (otherwise it's "at-station"). */
  departingSpeedKmh: number;
  /** A scheduled dwell shorter than this is treated as just-passing and
   *  surfaces as "arriving" rather than splitting into at-station. */
  minDwellGapMin: number;

  // ── Live data ───────────────────────────────────────────────────────
  /** Poll cadence for GTFS-RT VehiclePositions, in ms. The upstream feed
   *  typically updates every ≈10–20 s. */
  livePollMs: number;

  // ── Station selection (Stations view) ───────────────────────────────
  /** Primary "nearby" search radius from the user's location. Only stops
   *  within this distance are considered for the closest+2nd-closest
   *  pair rule. */
  nearbyRadiusM: number;
  /** A second stop joins the closest one ONLY when its distance to the
   *  user differs from the closest by at most this many meters. Keeps
   *  the view to the actual pair the user is standing between, never
   *  surfacing a far-second-best when the closest is unambiguous. */
  pairProximityM: number;
  /** Fallback search radius used only when nothing is within
   *  `nearbyRadiusM`. The selector then surfaces the closest stop
   *  within this radius that carries a favorited route. */
  favoriteFallbackRadiusM: number;

  // ── Arrivals window ───────────────────────────────────────────────
  /** How far into the future the Stations and Station-detail views
   *  ask the worker for arrivals. 18 h from any wall-clock time
   *  reaches the typical 04:00 GTFS end-of-service even at 10:00
   *  AM, so the per-station list never empties out mid-day for
   *  arbitrary horizon reasons. StationCard caps display to a few
   *  rows so a generous window is cheap. */
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
  nearbyRadiusM: 500,
  pairProximityM: 100,
  favoriteFallbackRadiusM: 2000,
  arrivalsWindowMin: 24 * 60,
};
