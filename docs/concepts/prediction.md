# Prediction

ETA estimation — what the app shows for "in X minutes" or "Departed".

## Current state

Shipped:
- Schedule-spine prediction: ETA = scheduled time, optionally corrected by reconciled live observations.
- Shape projection: `predictEta` projects live GPS onto the route polyline and produces a distance-along-shape, used for downstream stops on the same trip.
- Reconciler matches live vehicles to scheduled rows with adaptive tolerance, bipartite greedy matching, direction-id resolution per the [GTFS-RT contract](../specs/gtfs-rt-contract.md).

Source: [src/lib/domain/predictEta.ts](../../src/lib/domain/predictEta.ts), [src/lib/domain/shapeProjection.ts](../../src/lib/domain/shapeProjection.ts), [src/lib/domain/reconcile.ts](../../src/lib/domain/reconcile.ts).

## Settled decisions

Distilled from the prediction-v2 plan (now deleted; tracked across issues on `app` and `gtfs`).

- **Speed profile is per-feed, not per-route.** Lives in `gtfs/feeds/<id>/config.json`.
- **Intermediate-stop dwell flat 20 s.** Per-stop-class lookup is a future refinement.
- **Cascade includes the city-centre tier** (v1 formula). Centroid baked once per feed at build time.
- **`nowTicker = 15 s`** globally, synced with `livePollMs`. Map marker smoothness comes from RAF interpolation between ticks, not from a faster global tick.
- **All live-GPS bands extrapolate forward — with a speed horizon, not a time cap.** HEALTHY, STALE, and VERY_STALE all walk the shape forward from the last GPS-anchored `distAlongM` for the full fix age (up to the 15-min cutoff). The first `OBSERVED_WALK_MS` (90 s ≈ 6 live-poll cycles) trusts the fix's own speed; beyond it the walk continues at the TOD-bucket speed — the expected trajectory, GPS-anchored — because feed glitches routinely last minutes and a frozen marker would show stale-high ETAs, then jump on recovery. The walk is **dwell-aware**: every stop it crosses costs the feed's dwell seconds (same stop list + per-stop cost as the ETA's dwell term, in reverse), so a bus never skates "for free" past stops it must serve. An observed-stopped fix holds for one dwell cycle (`STOP_HOLD_MS`, 45 s ≈ 3 polls); past that the report is obsolete and the TOD walk resumes for the post-hold remainder — a dwelling bus doesn't skate past its stop, but a departed one doesn't linger as 'arriving now' either. `MAX_WALK_M` (5 km) is a defensive ceiling for glitch speeds. The bands differ only by **border colour** on the map marker, not by motion.
- **No Kalman, no ML, no always-on historical service.** Cascade is heuristic; everything's debuggable line by line.
- **Validation is empirical.** No formal test corpus; quality is judged by using the app. A regression-MAE pipeline is explicit anti-goal until we feel the lack of one.
- **Reconciliation matches by route order, not per-obs greedy.** Same `(route, dir)` cohort pairs bus with scheduled trip by sorted position, not by closest-match independently (which can swap two adjacent buses on a high-frequency line).
- **Cross-repo math sharing is deferred.** `gtfs` already maintains a manual vendored copy of polyline math and it has held up fine. No mirror tooling until the duplication actually hurts.

## Three loops

The app runs three independent loops; the manual refresh button fires all three for ~150 ms end-to-end responsiveness:

| Loop | Cadence | What |
|---|---|---|
| L1 — live poll | 15 s | GTFS-RT vehicle positions |
| L2 — UI tick | 15 s | Re-evaluate ETAs / buckets against new wall-clock |
| L3 — manual refresh | on tap | User-triggered L1 + L2 |

## Confidence interaction

Predicted rows without GPS confirmation render at `low` confidence (dimmed) per [confidence.md](confidence.md). At the trip origin the schedule is authoritative and the row stays at full opacity even without GPS — the bus is parked, not late.