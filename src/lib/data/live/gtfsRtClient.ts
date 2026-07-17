/*
 * gtfsRtClient — fetch & parse GTFS-RT VehiclePositions for a feed.
 *
 * GTFS-RT is a protobuf format ([spec](https://gtfs.org/realtime/reference/)).
 * The URL to call comes from `feed.realtime.vehicle_positions` in
 * feeds.json -- in production this is the canonical gtfs-rt.n3ary.com
 * proxy URL (the static pipeline rewrites it whenever the feed has a
 * per-feed config). The proxy sets Access-Control-Allow-Origin: *,
 * so the browser calls it directly with no same-origin intermediary.
 *
 * This module is "the I/O layer for live data". It returns a thin
 * shape (`LiveVehicleObservation`) that the reconciler can consume.
 * It does NOT yet decide what `kind` the vehicle is; that's the
 * reconciler's job downstream in the pipeline.
 */

// `gtfs-realtime-bindings` ships CJS with a default export. The
// generated types live in `gtfs-realtime.d.ts`. We narrow to the slice
// we actually read.
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';

const { FeedMessage } = GtfsRealtimeBindings.transit_realtime;

/** A single live observation of one vehicle at one point in time.
 *  Schema-stable; reconciler stages depend on this shape only. */
export interface LiveVehicleObservation {
  /** Source feed (the URL path piece, e.g. 'gtfs-rt'). Useful when the
   *  reconciler aggregates across multiple sources. */
  source: 'gtfs-rt';
  /** Operator-assigned vehicle id (e.g. '5012'). May be empty for some
   *  feeds — fall back to `entityId` then. */
  vehicleId: string;
  /** Canonical GTFS trip id (matches SQLite `trips.trip_id`) when the
   *  feed populates `trip.trip_id`. Empty if not assigned. */
  tripId: string;
  /** GTFS route id from the trip descriptor, when present. */
  routeId: string;
  /** 0 or 1, when the feed reports a direction. -1 when unknown. */
  directionId: number;
  /** Scheduled trip start time as reported on the TripDescriptor
   *  ("HH:MM:SS", may exceed 24:00:00 for past-midnight trips). Empty
   *  string if the feed doesn't populate it. Used by the reconciler to
   *  match this observation back to a static-GTFS trip by
   *  (routeId, directionId, startTime) since trip_ids can differ
   *  between the static-GTFS source and the GTFS-RT feed. */
  startTime: string;
  /** Last reported position. */
  lat: number;
  lon: number;
  /** Reported heading in degrees clockwise from north, when present. */
  bearing: number | null;
  /** Reported instantaneous speed in m/s, when present. */
  speedMs: number | null;
  /** GTFS-RT `current_status`: IN_TRANSIT_TO=0, STOPPED_AT=1, INCOMING_AT=2 */
  currentStatus: 0 | 1 | 2 | null;
  /** GTFS-RT next-stop hint, when present. */
  nextStopId: string | null;
  /** Unix ms of the report (NOT of the fetch). */
  asOfMs: number;
}

/** Result of one poll cycle. */
export interface VehiclePositionsSnapshot {
  /** Timestamp the upstream feed says this data is from. Unix ms. */
  feedTimestampMs: number;
  /** Vehicles observed. */
  vehicles: LiveVehicleObservation[];
}

/** Thrown when the RT endpoint isn't available for this feed (404, or
 *  the response body isn't protobuf). Distinct so the poll loop can
 *  treat it as "silently skip" instead of surfacing a scary error. */
export class RtUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RtUnavailableError';
  }
}

/** Fetch + parse the latest VehiclePositions for a feed. The caller
 *  passes the absolute URL straight from `feed.realtime.vehicle_positions`
 *  in feeds.json — no same-origin proxy needed because the new
 *  gtfs-rt server has CORS `*` enabled. The parser is intentionally
 *  I/O only — direction + start_time enrichment (per-feed quirks,
 *  SQL fallback) lives in `domain/enrichObservations.ts` so it can
 *  prefer authoritative static-feed data when available. */
export async function fetchVehiclePositions(feedId: string, url: string): Promise<VehiclePositionsSnapshot> {
  // AbortSignal.timeout: on flaky 5G the server may stream a partial
  // response that fails protobuf decode with a cryptic "missing required
  // header" error. A timeout converts it to a clean AbortError, which
  // the caller treats as a transient failure.
  const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(5_000) });
  // 404 from the proxy means the new gtfs-rt server has no snapshot
  // for this feed yet (e.g. upstream unreachable, or feed has no
  // realtime configured). Treat as "no RT" — the caller stops
  // polling for the session rather than showing a persistent error.
  if (res.status === 404) {
    throw new RtUnavailableError(`No live-data available for feed "${feedId}"`);
  }
  if (!res.ok) {
    throw new Error(`GTFS-RT fetch failed for ${feedId}: HTTP ${res.status}`);
  }
  // Defense-in-depth: a misrouted request could land on the SPA
  // fallback and return HTML. Protobuf-decoding HTML yields cryptic
  // "invalid wire type" errors — check content-type first.
  const ct = (res.headers.get('content-type') ?? '').toLowerCase();
  const looksProto =
    ct.startsWith('application/octet-stream') ||
    ct.startsWith('application/x-protobuf') ||
    ct.startsWith('application/protobuf') ||
    // Some servers omit the type entirely for .pb bodies
    ct === '';
  if (!looksProto) {
    throw new RtUnavailableError(
      `Live-data response for feed "${feedId}" was not protobuf (got "${ct}")`,
    );
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  return parseVehiclePositions(buf);
}

/** Pure parser — separated so tests can hand it a fixture buffer.
 *  Surfaces the GTFS-RT canonical fields verbatim; the enrichment
 *  pass downstream may overwrite `directionId` / `startTime` with
 *  authoritative static-feed values or per-feed quirks. */
export function parseVehiclePositions(buf: Uint8Array): VehiclePositionsSnapshot {
  const msg = FeedMessage.decode(buf);
  const feedTimestampMs = (Number(msg.header?.timestamp ?? 0) || 0) * 1000;
  const vehicles: LiveVehicleObservation[] = [];
  for (const entity of msg.entity ?? []) {
    const v = entity.vehicle;
    if (!v || !v.position) continue;
    const claimedDir = v.trip?.directionId ?? null;
    vehicles.push({
      source: 'gtfs-rt',
      vehicleId: v.vehicle?.id ?? entity.id ?? '',
      tripId: v.trip?.tripId ?? '',
      routeId: v.trip?.routeId ?? '',
      directionId: claimedDir === 0 || claimedDir === 1 ? claimedDir : -1,
      startTime: v.trip?.startTime ?? '',
      lat: v.position.latitude ?? 0,
      lon: v.position.longitude ?? 0,
      bearing: v.position.bearing ?? null,
      speedMs: v.position.speed ?? null,
      currentStatus: (v.currentStatus ?? null) as 0 | 1 | 2 | null,
      nextStopId: v.stopId || null,
      asOfMs: (Number(v.timestamp ?? 0) || 0) * 1000,
    });
  }
  return { feedTimestampMs, vehicles };
}
