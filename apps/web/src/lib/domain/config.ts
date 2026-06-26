/*
 * NearyConfig — single source of truth for all tunable thresholds used by
 * the bucketing, prediction, and reconciliation layers. Spec:
 * docs/rebuild-v2/vehicles-and-views.md §7.1.
 *
 * For now everyone reads `DEFAULT_CONFIG`. In Phase 5 the live worker
 * and the /settings/advanced view will be able to override individual
 * fields per session. Keeping all magic numbers behind one type means we
 * never have to grep the codebase to tune the app.
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
}

/** Production defaults. v1 magic numbers ported per spec §7.1. */
export const DEFAULT_CONFIG: NearyConfig = {
  proximityAtStationM: 50,
  offRouteDistanceM: 200,
  arrivingThresholdMin: 2,
  imminentEtaThresholdMin: 5,
  departingSpeedKmh: 5,
  minDwellGapMin: 1,
  livePollMs: 15_000,
};
