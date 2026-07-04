# GTFS-RT contract — producer owns cleanup

The contract that makes the consumer feed-agnostic: the
[gtfs](https://github.com/n3ary/gtfs) producer is the
**single owner of per-feed RT cleanup**. The consumer treats every
`realtime.vehicle_positions` URL in [feeds-json.md](feeds-json.md)
as **plain, spec-compliant GTFS-RT protobuf** and never branches on
`feed.id` for RT behavior.

Citations are from the official GTFS-Realtime spec maintained by
[MobilityData](https://gtfs.org/realtime/) at
[gtfs.org/realtime/reference](https://gtfs.org/realtime/reference/),
section paths shown inline.

## Why this exists

Per the [feed-agnostic standard](../standards/feed-agnostic.md), the
consumer code must not branch on feed identity. Several real feeds
publish RT payloads that don't fully conform to the GTFS-RT spec
(broken `direction_id`, missing `start_time`, etc.) — the consumer
needs *something* to clean those up, but that something is per-feed
knowledge and therefore must live upstream, not in the consumer.

The split:

- **Producer's RT adapter** (`gtfs/packages/gtfs-rt/`) — owns
  per-feed quirks, multi-source merge, and any other RT shaping.
  Publishes a clean `FeedMessage` to a URL the consumer can fetch.
- **Consumer** (`neary`, this repo) — fetches the clean URL, decodes
  the protobuf, and feeds it to the reconciler. No per-feed branches.

## Spec-cited contract

For every `VehiclePosition` entity in the producer's clean feed:

### Trip identification — at least one canonical key

> [GTFS-RT Reference → TripDescriptor.trip_id](https://gtfs.org/realtime/reference/#message-tripdescriptor)
>
> "For non frequency-based trips (trips not defined in GTFS
> frequencies.txt), this field is enough to uniquely identify the
> trip."
>
> "If the `trip_id` field can't be provided, then `route_id`,
> `direction_id`, `start_date`, and `start_time` must all be
> provided."

The producer MUST populate at least one of the following so the
consumer can resolve the observation to a single scheduled trip:

| key | rule |
|---|---|
| `trip_id` | Preferred for non-frequency trips. The value MUST resolve to a row in the static feed's `trips.txt`. |
| `route_id` + `direction_id` + `start_date` + `start_time` (all four) | The spec-blessed alternate key when `trip_id` is unavailable. |
| `schedule_relationship` | `SCHEDULED` (default) signals "in accordance with GTFS schedule, or close enough to be associated with it" ([ScheduleRelationship](https://gtfs.org/realtime/reference/#enum-schedulerelationship)). |

A `SCHEDULED` entity that provides **neither** a resolving `trip_id`
nor the full four-field alternate key is malformed per spec and may
be discarded by the consumer (see Failure mode).

### `direction_id` — must match the trip's actual direction

> [GTFS-RT Reference → TripDescriptor.trip_id (route_id consistency rule)](https://gtfs.org/realtime/reference/#message-tripdescriptor)
>
> "If `route_id` is provided in addition to `trip_id`, then the
> `route_id` must be the same `route_id` as assigned to the given trip
> in GTFS trips.txt."

The same consistency requirement applies implicitly to `direction_id`
— it must be 0 or 1 and must match the trip's actual direction per
`trips.txt`. Producers that publish `direction_id=0` for every
vehicle (the Cluj upstream case) are non-conformant; the adapter's job
is to recover the correct value, not the consumer's.

### `start_time` — present and matching for non-frequency trips

> [GTFS-RT Reference → TripDescriptor.start_time](https://gtfs.org/realtime/reference/#message-tripdescriptor)
>
> "When the `trip_id` corresponds to a non-frequency-based trip, this
> field **should either be omitted or be equal to the value in the
> GTFS feed**."

For `SCHEDULED` non-frequency trips, the canonical `HH:MM:SS` start
time MUST either be omitted or equal the static feed's
`stop_times.departure_time` for the trip's origin stop. Producers that
publish `start_time=""` for every vehicle are non-conformant; the
adapter recovers it, not the consumer.

For `UNSCHEDULED` (`frequencies.txt` `exact_times=0`) trips, `trip_id`
+ `start_time` + `start_date` are **all required**.

### `start_date` — required when service-day ambiguity exists

> [GTFS-RT Reference → TripDescriptor.start_date](https://gtfs.org/realtime/reference/#message-tripdescriptor)
>
> "For scheduled trips ... this field must be provided to
> disambiguate trips that are so late as to collide with a scheduled
> trip on a next day."

The producer MUST populate `start_date` whenever the entity's `trip_id`
or alternate key could resolve to multiple service days.

### Cross-feed invariants (when `TripUpdate` is also published)

> [GTFS-RT Best Practices](https://gtfs.org/realtime/best-practices/)
>
> "If separate `VehiclePosition` and `TripUpdate` feeds are provided,
> `TripDescriptor` and `VehicleDescriptor` ID values pairing should
> match between the two feeds."

If the producer splits VP and TU into separate upstream sources, the
adapter's merge layer is responsible for emitting feeds that satisfy
this invariant.

## Failure mode (spec-blessed)

> [GTFS-RT Reference → TripDescriptor](https://gtfs.org/realtime/reference/#message-tripdescriptor)
>
> "If the TripDescriptor does not resolve to a single trip instance
> (i.e., it resolves to zero or multiple trip instances), it is
> considered an error and the entity containing the erroneous
> TripDescriptor **may be discarded by consumers**."

The consumer's reconciler treats unmatched entities as `kind:
'gps-only'` rather than discarding them — slightly more permissive
than the spec requires (which is allowed), so a vehicle still appears
on the map with reduced-confidence markers and the user can see the
data is approximate. The producer's adapter is still responsible for
ensuring the canonical fields are populated so this fallback stays
rare.

## What the consumer does

The consumer's worker
([`livePipeline.ts`](../../src/lib/workers/gtfs/livePipeline.ts))
trusts the contract:

1. Fetch the URL in `realtime.vehicle_positions`.
2. Decode as GTFS-RT protobuf (`gtfs-realtime-bindings`).
3. Pass observations to
   [`reconcileWithLive`](../../src/lib/domain/reconcile.ts), which
   matches live observations to scheduled trips by
   `(routeId, directionId, startTime)` with adaptive tolerance (see
   [live-data-pipeline.md](live-data-pipeline.md) for the reconciler
   rationale). This implements the spec's alternate-key pattern with
   one addition: the adaptive tolerance window to handle lateness
   within a single headway interval.
4. Emit `kind: 'gps-only'` for unmatched observations whose route
   shows up on the active set; the station side re-seeds the ETA
   from sibling shape data.

No fallback path tries to recover `direction_id` from `trip_id` or
any other operator-internal encoding. Per the standard, doing so
would put per-feed knowledge back into the consumer.

## What the producer does

The producer's RT adapter (`gtfs/packages/gtfs-rt/`):

1. Polls one or more upstream RT endpoints per feed at ~30 s cadence.
2. **Merges multi-source observations** (per
   [multi-source-live-data.md](multi-source-live-data.md) merge
   semantics — fresher `timestamp` wins; tie breaks on config order).
3. **Applies per-feed quirks** — one module per feed under
   `packages/gtfs-rt/src/quirks/`. The Cluj pilot recovers
   `direction_id` and `start_time` from the
   `<route>_<dir>_<service>_<run>_<HHMM>`-encoded `trip_id` when the
   upstream publishes `direction_id=0` for every vehicle and an empty
   `start_time`. Each quirk module is small (~50–100 lines) and only
   loaded for the feeds it targets.
4. Publishes the clean `FeedMessage` to the URL declared in
   `feeds.json.realtime.vehicle_positions`. The CF Pages Function (or
   Worker) caches the response on the edge so the consumer sees the
   same `max-age` cache semantics as it does today.

The producer's per-feed quirks are the **only** place where per-feed
RT knowledge lives. Adding a quirk is a new module in the producer's
`quirks/` directory, not a PR to this consumer repo.

## Bridge until the producer adapter ships

The gap between this contract's "consumer trusts canonical fields"
rule and the producer's adapter actually shipping direction_id and
start_time correctly is bridged by an inline, **shape-gated** fallback
in
[`enrichObservations.ts`](../../src/lib/domain/enrichObservations.ts).
The fallback fires only when the upstream `start_time` is empty AND
the `trip_id` matches the documented
`<route>_<dir>_<service>_<run>_<HHMM>` shape. It does **not** branch
on `feed.id`, so it stays compatible with
[feed-agnostic.md](../standards/feed-agnostic.md) (branch on
capability / shape, never on feed id / agency / city).

**Removal trigger**: delete the inline shape-gated block once the
producer's adapter has been live for a week without orphan-regression
on Cluj. The block carries a `TEMP:` marker pointing to this
contract section as the trigger.

## When this contract changes

If the GTFS-RT spec itself changes (rare), or if we add a new
`realtime.*` endpoint type, the contract above is the canonical
reference. Changes should be coordinated across both repos:

1. Producer: add the new shape or quirk in `gtfs`.
2. Consumer: add a reader for the new shape in this repo.
3. Both: ship together or with a back-compat window.

## References

- [GTFS Realtime Reference](https://gtfs.org/realtime/reference/) —
  canonical authority for every rule above
- [GTFS Realtime Best Practices](https://gtfs.org/realtime/best-practices/)
- [GTFS Realtime Protobuf](https://gtfs.org/realtime/proto/)
- [live-data-pipeline.md](live-data-pipeline.md) — reconciler
  algorithm, timezone discipline, freshness rules
- [multi-source-live-data.md](multi-source-live-data.md) — multi-URL
  semantics; the merge step moves to the producer's adapter
- [feeds-json.md](feeds-json.md) — manifest contract; the
  `realtime.vehicle_positions` URL must point at a clean source
- [feed-agnostic.md](../standards/feed-agnostic.md) —
  the rule this contract enforces