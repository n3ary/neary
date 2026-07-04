/*
 * dwell — per-stop dwell time used by `predictArrivalAlongShape` when
 * walking forward through intermediate stops.
 *
 * Today: flat 20 s for intermediate stops, 0 at origin/terminus.
 * Abstracted so per-stop-class lookup (terminal vs through-stop) is a
 * one-file change when we have observation data.
 *
 * Mirrors `intermediateDwellSec` in `gtfs/feeds/cluj-napoca/config.json`.
 */

const DEFAULT_INTERMEDIATE_DWELL_SEC = 20;

export interface DwellInputs {
  /** True when the stop is the trip's origin (first) or terminus (last).
   *  Operator's published times include layover at these stops, so we
   *  add zero dwell on top. */
  isEndpoint: boolean;
}

export function dwellSecondsFor(inputs: DwellInputs): number {
  return inputs.isEndpoint ? 0 : DEFAULT_INTERMEDIATE_DWELL_SEC;
}
