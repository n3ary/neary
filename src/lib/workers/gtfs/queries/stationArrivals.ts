/*
 * Per-stop scheduled arrivals — the main station-card data source.
 *
 * Returns one `Vehicle` per scheduled arrival at this stop, in the
 * "today + window" view. Everything is `kind: 'scheduled'`; the
 * reconciliation upgrade happens later via `mergeReconciledIntoStationBoard`
 * on the main thread using the worker's broadcast.
 *
 * For frequency-based trips (rows in `frequencies.txt`), each
 * generated departure is emitted as its own `kind: 'scheduled'`
 * Vehicle with `schedule.tripStartMin` set to the effective
 * departure time and `id: trip:${tripId}@${effectiveStartMin}`.
 */

import type { Database } from '@sqlite.org/sqlite-wasm';
import type { Vehicle } from '$lib/domain/types';
import { scanSchedule, type ScheduleRow } from '$lib/domain/pipeline/scheduleScanner';
import { dateKeyInTz, minSinceMidnightInTz, timeToMinutes } from '$lib/domain/pipeline/timeUtils';
import { activeServicesOn } from '../activeServices';
import { selectAll } from '../sqlHelpers';
import {
  expandFrequencyToDepartures,
  getAnchorStopTimes,
  getFrequenciesForServices,
} from './frequencyExpansion';

export function getStationArrivals(
  db: Database,
  tz: string,
  stopId: string,
  nowMs: number,
  windowMinutes: number,
  hasFrequencies: boolean,
): Vehicle[] {
  const localDate = dateKeyInTz(nowMs, tz);
  const nowMinSinceMidnight = minSinceMidnightInTz(nowMs, tz);

  const services = activeServicesOn(db, localDate);
  if (services.length === 0) return [];

  const placeholders = services.map(() => '?').join(',');
  const rows = selectAll<ScheduleRow>(
    db,
    // Four correlated subqueries per row:
    //   first_seq        — trip's origin index. Used to flag the
    //                      row as "this stop is the trip's start"
    //                      so the UI can render it at full opacity
    //                      (schedule is authoritative there) while
    //                      fading intermediate-stop scheduled rows.
    //   last_seq         — trip's end-stop index, used to detect
    //                      drop-off-only arrivals there.
    //   trip_end_time    — arrival_time at the end stop, used to keep
    //                      a vehicle in the 'departed' bucket only
    //                      while it's still en route (not yet arrived
    //                      at its end stop).
    //   trip_start_time  — departure_time at the FIRST stop
    //                      (origin). Surfaced for the reconciler so it
    //                      can match live observations by
    //                      (route, direction, start_time) instead of
    //                      trip_id (trip_ids drift between static GTFS
    //                      and GTFS-RT feeds in some operators).
    // All four are cheap thanks to stop_times_trip_seq_idx (trip_id, stop_sequence).
    `SELECT st.trip_id, st.arrival_time, st.departure_time, st.pickup_type,
            st.stop_sequence,
            t.direction_id,
            (SELECT MIN(stop_sequence) FROM stop_times WHERE trip_id = st.trip_id) AS first_seq,
            (SELECT MAX(stop_sequence) FROM stop_times WHERE trip_id = st.trip_id) AS last_seq,
            (SELECT arrival_time FROM stop_times WHERE trip_id = st.trip_id
             ORDER BY stop_sequence DESC LIMIT 1) AS trip_end_time,
            (SELECT departure_time FROM stop_times WHERE trip_id = st.trip_id
             ORDER BY stop_sequence ASC LIMIT 1) AS trip_start_time,
            r.route_id, r.route_short_name, r.route_color, r.route_text_color, r.route_type,
            t.trip_headsign,
            s.stop_lat, s.stop_lon
     FROM stop_times st
     JOIN trips t  ON t.trip_id  = st.trip_id
     JOIN routes r ON r.route_id = t.route_id
     JOIN stops s  ON s.stop_id  = st.stop_id
     WHERE st.stop_id = ?
       AND t.service_id IN (${placeholders});`,
    [stopId, ...services],
  );

  // Frequency expansion at this stop. For each frequency-based trip
  // whose anchor passes through `stopId`, expand into one row per
  // generated departure whose effective time at THIS stop falls in
  // the query window. The per-stop effective arrival time is
  // anchor's stop_times.arrival_time + k*headway_min.
  let frequencyRows: ScheduleRow[] = [];
  if (hasFrequencies) {
    const freqs = getFrequenciesForServices(db, services);
    const tripIds = Array.from(new Set(freqs.map((f) => f.trip_id)));
    // Pull all stop_times for the frequency-based trips in one
    // query so we can derive the per-stop offset for each.
    const tripPh = tripIds.length === 0 ? '' : `AND st.trip_id IN (${tripIds.map(() => '?').join(',')})`;
    type FreqTripRow = {
      trip_id: string;
      trip_headsign: string | null;
      direction_id: number | null;
      route_id: string;
      route_short_name: string;
      route_color: string | null;
      route_text_color: string | null;
      route_type: number | null;
    };
    const tripMeta = tripIds.length === 0 ? new Map<string, FreqTripRow>() : new Map(
      selectAll<FreqTripRow>(
        db,
        `SELECT t.trip_id, t.trip_headsign, t.direction_id,
                r.route_id, r.route_short_name, r.route_color, r.route_text_color, r.route_type
         FROM trips t JOIN routes r ON r.route_id = t.route_id
         WHERE 1=1 ${tripPh};`,
        tripIds,
      ).map((r) => [r.trip_id, r]),
    );
    const upper = nowMinSinceMidnight + windowMinutes;
    for (const f of freqs) {
      const anchor = tripMeta.get(f.trip_id);
      if (!anchor) continue;
      const stops = getAnchorStopTimes(db, f.trip_id);
      // Pick the stop_times row for THIS stop. Most anchors have one
      // row per stop_sequence; we want the matching one.
      const thisStop = stops.find((s) => s.stop_id === stopId);
      if (!thisStop) continue;
      // Pull the stop's coords for the row (used by downstream
      // consumers even though scanSchedule itself doesn't read them).
      const stopCoords = selectAll<{ stop_lat: number; stop_lon: number }>(
        db,
        `SELECT stop_lat, stop_lon FROM stops WHERE stop_id = ?;`,
        [stopId],
      );
      const stopLat = stopCoords[0]?.stop_lat ?? 0;
      const stopLon = stopCoords[0]?.stop_lon ?? 0;
      const deps = expandFrequencyToDepartures(f, nowMinSinceMidnight - 60, upper);
      const offsetMin = timeToMinutes(thisStop.arrival_time);
      if (!Number.isFinite(offsetMin)) continue;
      // First/last_seq for the trip (the anchor's stop_sequence
      // range). Cheap: one SELECT per trip but stops is in memory
      // and small.
      const firstSeq = stops[0]?.stop_sequence ?? thisStop.stop_sequence;
      const lastSeq = stops[stops.length - 1]?.stop_sequence ?? thisStop.stop_sequence;
      const anchorStartMin = timeToMinutes(f.start_time);
      const anchorEndMin = timeToMinutes(f.end_time);
      if (!Number.isFinite(anchorStartMin) || !Number.isFinite(anchorEndMin)) continue;
      for (const dep of deps) {
        // Effective arrival at this stop = anchor's stop_times offset + (effectiveStart - anchor start).
        // i.e. shift the anchor row's time by the same delta we applied to the trip origin.
        const delta = dep.effectiveStartMin - anchorStartMin;
        const effArrivalMin = offsetMin + delta;
        const effDepartureMin = timeToMinutes(thisStop.departure_time) + delta;
        const effTripEndMin = anchorEndMin + delta;
        // Window: keep rows whose effective time at this stop is in [now, now+window].
        if (effArrivalMin < nowMinSinceMidnight) continue;
        if (effArrivalMin > upper) continue;
        // Use the effArrivalMin-formatted time so scanSchedule sees the
        // effective arrival; we set trip_start_time = effectiveStartMin
        // (the reconciler key) and leave arrival_time/departure_time as
        // the effective per-stop times.
        const pad2 = (n: number) => String(n).padStart(2, '0');
        const h = (m: number) => {
          const hh = Math.floor(m / 60);
          const mm = m % 60;
          return `${pad2(hh)}:${pad2(mm)}:00`;
        };
        // Join the trip + route data so scanSchedule can project
        // without re-querying. Reuse the existing ScheduleRow
        // shape: trip_id, arrival_time, departure_time, stop_sequence,
        // first_seq, last_seq, trip_start_time, trip_end_time, etc.
        frequencyRows.push({
          trip_id: f.trip_id,
          // Stable id encodes the generated departure's effective
          // origin time so each row is uniquely identifiable
          // downstream (the per-stop `mergeReconciledIntoStationBoard`
          // promotion path uses Vehicle.id as a stable Svelte key).
          id: `trip:${f.trip_id}@${dep.effectiveStartMin}`,
          arrival_time: h(effArrivalMin),
          departure_time: h(effDepartureMin),
          pickup_type: thisStop.pickup_type,
          stop_sequence: thisStop.stop_sequence,
          first_seq: firstSeq,
          last_seq: lastSeq,
          trip_end_time: h(effTripEndMin),
          trip_start_time: h(dep.effectiveStartMin),
          direction_id: anchor.direction_id,
          route_id: anchor.route_id,
          route_short_name: anchor.route_short_name,
          route_color: anchor.route_color,
          route_text_color: anchor.route_text_color,
          route_type: anchor.route_type,
          trip_headsign: anchor.trip_headsign,
          stop_lat: stopLat,
          stop_lon: stopLon,
        });
      }
    }
  }

  return scanSchedule({
    rows: [...rows, ...frequencyRows],
    nowMinSinceMidnight,
    nowMs,
    windowMinutes,
  });
}
