/*
 * gtfsRtClient — fetch & parse GTFS-RT VehiclePositions for a feed.
 *
 * GTFS-RT is a protobuf format ([spec](https://gtfs.org/realtime/reference/)).
 * Upstream endpoints don't return CORS headers, so the client hits a
 * same-origin proxy at `/api/rt/<feedId>/<endpoint>` — wired up in
 *   - apps/web/vite.config.ts (dev)
 *   - /netlify.toml          (prod)
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

/** Fetch + parse the latest VehiclePositions for a feed. */
export async function fetchVehiclePositions(feedId: string): Promise<VehiclePositionsSnapshot> {
  const url = `/api/rt/${encodeURIComponent(feedId)}/vehiclePositions`;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`GTFS-RT fetch failed for ${feedId}: HTTP ${res.status}`);
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  return parseVehiclePositions(buf);
}

/** Pure parser — separated so tests can hand it a fixture buffer. */
export function parseVehiclePositions(buf: Uint8Array): VehiclePositionsSnapshot {
  const msg = FeedMessage.decode(buf);
  const feedTimestampMs = (Number(msg.header?.timestamp ?? 0) || 0) * 1000;
  const vehicles: LiveVehicleObservation[] = [];
  for (const entity of msg.entity ?? []) {
    const v = entity.vehicle;
    if (!v || !v.position) continue;
    vehicles.push({
      source: 'gtfs-rt',
      vehicleId: v.vehicle?.id ?? entity.id ?? '',
      tripId: v.trip?.tripId ?? '',
      routeId: v.trip?.routeId ?? '',
      directionId: v.trip?.directionId ?? -1,
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
