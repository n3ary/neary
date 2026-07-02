/*
 * Pipeline scaffolding for vehicle assembly.
 *
 * The output of the pipeline is `Vehicle[]` ready for the UI. The pipeline
 * is a list of stages run in order; each stage takes the current
 * `PipelineState` and returns a new one. Stages are pure(ish) — they may
 * read DB / network state held in `PipelineContext`, but never write to it.
 *
 * The shape of the pipeline depends on what data sources are wired up:
 *
 *   features          | stages
 *   ----------------- | ------------------------------------------------------
 *   schedule only     | scheduleScanner
 *   + gtfs-rt         | scheduleScanner, rtIngester, scheduleReconciler
 *   + multi-RT        | scheduleScanner, rtIngester, scheduleReconciler,
 *                     |   multiSourceCorroborator
 *
 * Today only `scheduleScanner` is wired. The live stages (rtIngester,
 * scheduleReconciler, multiSourceCorroborator) will layer
 * on top without touching scheduleScanner or anything downstream of the
 * pipeline (UI, buckets, sort).
 *
 * Spec: docs/specs/vehicles-and-views.md.
 */

import type { Vehicle } from '../types';

/** Per-view context passed to every stage. Holds what the stage needs but
 *  may not mutate (db is read-only, prefs are a snapshot). */
export interface PipelineContext {
  /** Unix ms of the moment this pipeline run represents. Stages should
   *  consistently use this, NOT `Date.now()` — keeps results deterministic
   *  and easy to test. */
  nowMs: number;
  /** Minutes since local midnight derived from `nowMs` (matches GTFS
   *  arrival/departure times). */
  nowMinSinceMidnight: number;
  /** Local YYYYMMDD for service-calendar lookups. */
  localDate: string;
}

/** A stage is a function `(state, context) -> state`. Stages are run in
 *  order; later stages may mutate (kind/confidence/liveSources/etc.) any
 *  vehicle produced by earlier stages, or add new vehicles. */
export interface Stage<Ctx extends PipelineContext = PipelineContext> {
  name: string;
  run(state: Vehicle[], context: Ctx): Vehicle[] | Promise<Vehicle[]>;
}

/** Run a pipeline of stages sequentially. */
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
