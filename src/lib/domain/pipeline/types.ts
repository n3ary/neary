// Pipeline scaffolding for vehicle assembly. Each stage reads PipelineContext (never mutates) and returns a new Vehicle[]. Spec: docs/specs/vehicles-and-views.md.

import type { Vehicle } from '../types';

/** Per-view context passed to every stage. Holds what the stage needs but may not mutate (db is read-only, prefs are a snapshot). */
export interface PipelineContext {
  /** Stages use this consistently (never `Date.now()`) — keeps results deterministic and easy to test. */
  nowMs: number;
  /** Minutes since local midnight derived from `nowMs` (matches GTFS arrival/departure times). */
  nowMinSinceMidnight: number;
  /** Local YYYYMMDD for service-calendar lookups. */
  localDate: string;
}

/** A stage runs in order; later stages may mutate (kind/confidence/liveSources/etc.) any vehicle produced by earlier stages, or add new vehicles. */
export interface Stage<Ctx extends PipelineContext = PipelineContext> {
  name: string;
  run(state: Vehicle[], context: Ctx): Vehicle[] | Promise<Vehicle[]>;
}

export async function runPipeline<Ctx extends PipelineContext>(
  stages: Stage<Ctx>[],
  context: Ctx,
): Promise<Vehicle[]> {
  let state: Vehicle[] = [];
  for (const stage of stages) {
    state = await stage.run(state, context);
  }
  return state;
}
