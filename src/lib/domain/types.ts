/*
 * Domain types — UI-facing shapes used by the composite primitives
 * (RouteBadge, VehicleCard, StationCard) and by the upcoming domain layer
 * (prediction, reconciler, buckets).
 *
 * Vehicle model: four kinds describing the *source of position knowledge*:
 *
 *   scheduled  in the schedule. Position is either absent (trip not yet
 *              active or no interpolation) or interpolated from the
 *              schedule (when the trip is currently running per
 *              schedule.tripPhase but no live source has matched it).
 *   gps-only   live GPS, no schedule trip matched
 *   tracked    live GPS + matched scheduled trip (1 live source)
 *   verified   live GPS + matched scheduled trip + ≥2 live sources agree
 *
 * Whether the trip "should be running" is encoded on Axis A via
 * `schedule.tripPhase` (`next` / `last` / `on-route` / `later`), not
 * on `kind`. See docs/concepts/vehicle.md.
 */

/** A single transit route as the UI sees it. */
export interface Route {
  /** GTFS route_id — a free-form text identifier per the GTFS spec.
   *  We keep it as a string everywhere so feeds with non-numeric ids
   *  (Cluj has '102L') round-trip cleanly through URLs, localStorage,
   *  and set membership without lossy coercion. */
  id: string;
  /** Short marketing identifier (GTFS route_short_name): '24', 'M1',
   *  'B12'. This is what users actually read; never use it as an
   *  identifier. */
  shortName: string;
  /** Hex color, including the leading "#". The text color is computed. */
  color: string;
  /** Optional explicit foreground; if omitted we compute a contrast color. */
  textColor?: string;
  /** Vehicle type that runs this route, derived from GTFS
   *  `routes.route_type`. Optional so existing producers that don’t
   *  populate it still typecheck — callers must tolerate undefined
   *  and fall back to 'unknown'. */
  type?: VehicleType;
}

/** A station / stop as the UI sees it. */
export interface Station {
  id: number;
  name: string;
  /** Distance from the user in meters. Undefined for non-located contexts. */
  distance?: number;
  lat?: number;
  lon?: number;
}

/** GPS fix snapshot — used historically; kept for compat. */
export interface GpsFix {
  lat: number;
  lon: number;
  /** Unix ms timestamp. */
  observedAt: number;
}

/** Which live feed produced an observation. */
export type LiveSource = 'gtfs-rt' | 'tranzy';

/** Confidence in the vehicle's stated position / match. Derived strictly
 *  from kind + liveSources by the reconciler. */
export type Confidence = 'high' | 'medium' | 'low';
/** Vehicle position with provenance, so the UI can choose how much to
 *  trust it without re-deriving from kind. */
export interface VehiclePosition {
  lat: number;
  lon: number;
  /** Where this position came from. */
  source: 'gps' | 'predicted-from-schedule' | 'predicted-from-gps';
  /** Unix ms — GPS fix time for `source=gps`, prediction time otherwise. */
  asOf: number;
  /** Reported instantaneous speed in m/s, when the live source carries
   *  it. Used by the GPS-derived ETA predictor; absent / null means
   *  fall back to a config-driven average. */
  speedMs?: number | null;
}

/** ETA at the *target* stop for a given view. Negative minutes = already
 *  passed (departed bucket). */
export interface VehicleEta {
  distanceMeters: number;
  minutes: number;
  confidence: Confidence;
}

/** A scheduled run on a route, attached to a vehicle. Departure/arrival
 *  times are expressed as minutes since local midnight at the *target stop*
 *  the vehicle is rendered for (station view) — never the trip start time. */
export interface ScheduledRun {
  tripId: string;
  /** Minutes since local midnight at the target stop. */
  scheduledDeparture: number;
  /** Arrival time at the target stop, if distinct from departure. Same units. */
  scheduledArrival?: number;
  headsign?: string;
  /** GTFS `trips.direction_id` (0 or 1). Used by the reconciler as part
   *  of the live-match key. -1 if the feed doesn't populate direction. */
  directionId?: 0 | 1 | -1;
  /** True when this scheduled row represents the trip's FIRST stop
   *  (stop_sequence === first_seq). Named from the row's POV: this
   *  stop is the trip's origin — not "the vehicle is at the origin".
   *  UI uses this to keep the row at full opacity even when there's
   *  no live match — at the origin the schedule IS authoritative
   *  (the bus hasn't started moving yet, so there can never be a
   *  GPS match before scheduled departure). At intermediate stops a
   *  scheduled (no-GPS) row is faded. */
  isFirstStop?: boolean;
  /** True when this stop is the trip's LAST stop (stop_sequence ===
   *  last_seq). Named from the row's POV: this stop is the trip's
   *  terminus — not "the vehicle is at the terminus". Used to
   *  suppress the upcoming-stops expansion (there are no further
   *  stops to show) and to treat the row as drop-off-only regardless
   *  of `pickup_type`. */
  isLastStop?: boolean;
  /** Classifies this trip's phase in its daily lifecycle on the
   *  route, relative to `now`:
   *   - 'next'     → the next departure that hasn't left
   *   - 'last'     → the most recent departure that has left and is
   *                  still running (trip not yet at terminus)
   *   - 'on-route' → an earlier departure that has left and is still
   *                  running (not the most recent)
   *   - 'later'    → a future origin departure that is not the next
   *
   *  Set on every emitted row (not only origin rows): tripPhase is a
   *  property of the trip's lifecycle, independent of which stop's
   *  row we're looking at. UI consumers (drop-off filter, action-
   *  button gates) need the phase at terminus and midpoints, not
   *  only at the origin stop.
   *
   *  Recomputed on every snapshot regeneration because the phase is
   *  a function of `now`. Undefined only when `tripStartMin` is
   *  unknown. */
  tripPhase?: 'next' | 'last' | 'on-route' | 'later';
  /** Minutes since local midnight at the trip's FIRST stop (origin
   *  departure time). Used by the reconciler to match live observations
   *  to scheduled trips by `(routeId, directionId, tripStartMin)` with
   *  adaptive tolerance — independent of trip_id, since trip_id can
   *  differ between the static GTFS source and the GTFS-RT feed. */
  tripStartMin?: number;
}

/** Vehicle type — orthogonal to `kind` (which is about source of position
 *  knowledge). Maps from GTFS `routes.route_type` per the spec:
 *  https://gtfs.org/schedule/reference/#routestxt */
export type VehicleType =
  | 'tram'        // 0
  | 'metro'       // 1
  | 'rail'        // 2
  | 'bus'         // 3
  | 'ferry'       // 4
  | 'cablecar'    // 5
  | 'gondola'     // 6
  | 'funicular'   // 7
  | 'trolleybus'  // 11
  | 'monorail'    // 12
  | 'unknown';

/** Map GTFS route_type integer to a VehicleType. Unknown values fall back
 *  to 'bus' for the common case (extended types in the 700-1700 range are
 *  HVT — Hierarchical Vehicle Types — usually buses). */
export function vehicleTypeFromGtfs(routeType: number | null | undefined): VehicleType {
  switch (routeType) {
    case 0: return 'tram';
    case 1: return 'metro';
    case 2: return 'rail';
    case 3: return 'bus';
    case 4: return 'ferry';
    case 5: return 'cablecar';
    case 6: return 'gondola';
    case 7: return 'funicular';
    case 11: return 'trolleybus';
    case 12: return 'monorail';
    default:
      if (routeType == null) return 'unknown';
      // HVT extended range 100..199 = Rail, 200..299 = Coach, 700..899 = Bus,
      // 900..999 = Tram, 1000..1099 = Water, 1100..1199 = Air,
      // 1200..1299 = Ferry, 1300..1399 = Aerial, 1400..1499 = Funicular,
      // 1500..1599 = Taxi, 1700..1799 = Other.
      if (routeType >= 100 && routeType < 200) return 'rail';
      if (routeType >= 700 && routeType < 900) return 'bus';
      if (routeType >= 900 && routeType < 1000) return 'tram';
      if (routeType >= 1200 && routeType < 1300) return 'ferry';
      if (routeType >= 1400 && routeType < 1500) return 'funicular';
      return 'bus';
  }
}

/** Human-readable label for a VehicleType, used in row labels like
 *  "Bus 25" / "Tram 101". Title-case, English; consumers can wrap for
 *  i18n later. */
export function vehicleTypeLabel(t: VehicleType): string {
  switch (t) {
    case 'tram': return 'Tram';
    case 'metro': return 'Metro';
    case 'rail': return 'Rail';
    case 'bus': return 'Bus';
    case 'ferry': return 'Ferry';
    case 'cablecar': return 'Cable car';
    case 'gondola': return 'Gondola';
    case 'funicular': return 'Funicular';
    case 'trolleybus': return 'Trolleybus';
    case 'monorail': return 'Monorail';
    default: return 'Route';
  }
}

interface VehicleBase {
  id: string;
  route: Route;
  /** Mode of transport. Set by the pipeline from the route's GTFS route_type. */
  type: VehicleType;
  /** GTFS trip_id this Vehicle represents. Present for every kind
   *  that has trip-level identity (scheduled, tracked, verified) set
   *  it from the static schedule; gps-only orphans set
   *  it from the live observation). Used by `applyGpsEta` for shape
   *  lookup so we don't have to reach into `schedule.tripId`
   *  (which orphans don't have). */
  tripId?: string;
  /** GTFS direction_id (0 or 1), or -1 when unknown. Trip-level
   *  property — set wherever `tripId` is set. Used as the fallback
   *  shape-lookup key when the trip_id's own shape isn't available
   *  (route-level shapes are shared across trips on the same
   *  (route, direction) in every feed we've seen). */
  directionId?: 0 | 1 | -1;
  /** Final headsign for display; reconciler resolves from schedule or live. */
  headsign?: string;
  eta?: VehicleEta;
  confidence: Confidence;
  /** True if this stop is marked drop-off-only for this trip (GTFS
   *  `stop_times.pickup_type = 1`). UI hides by default unless
   *  `userPrefs.showDropOffOnly`. Only meaningful in station-view context. */
  dropOffOnly?: boolean;
}

export type Vehicle =
  | (VehicleBase & {
      kind: 'scheduled';
      schedule: ScheduledRun;
      /** Optional interpolated position. Present when the trip is
       *  currently running per `schedule.tripPhase` (`last` /
       *  `on-route`) but no live source has matched it; the position
       *  is derived from the schedule along the route shape and its
       *  `source` is `'predicted-from-schedule'`. Absent for trips
       *  that haven't started yet (`next` / `later`). */
      position?: VehiclePosition;
      liveSources?: never;
    })
  | (VehicleBase & {
      kind: 'gps-only';
      /** Always present and always `gps`. */
      position: VehiclePosition;
      /** Pure live vehicles have no schedule match yet. */
      schedule?: ScheduledRun;
      /** Always at least one source. */
      liveSources: LiveSource[];
    })
  | (VehicleBase & {
      kind: 'tracked';
      position: VehiclePosition;
      schedule: ScheduledRun;
      /** Exactly one source. */
      liveSources: LiveSource[];
    })
  | (VehicleBase & {
      kind: 'verified';
      position: VehiclePosition;
      schedule: ScheduledRun;
      /** Two or more sources, all agreeing on the matched trip. */
      liveSources: LiveSource[];
    });

/**
 * Pick a foreground color (black or white) that has enough contrast against a
 * given hex background. Uses sRGB relative luminance, not perceptual lightness;
 * good enough for transit route palettes which never sit near the boundary.
 */
export function pickContrastingText(hex: string): '#000' | '#fff' {
  const c = hex.replace('#', '');
  if (c.length !== 6) return '#000';
  const r = parseInt(c.substring(0, 2), 16);
  const g = parseInt(c.substring(2, 4), 16);
  const b = parseInt(c.substring(4, 6), 16);
  // Relative luminance approximation (faster than full sRGB linearization).
  const L = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return L > 0.6 ? '#000' : '#fff';
}

/** Format a scheduled-departure minutes-since-midnight value as "HH:MM".
 *  Wraps the hour modulo 24 so GTFS extended times (e.g. 25:30 for a
 *  night route running past midnight) display as their wall-clock
 *  equivalent ("01:30") rather than being clamped to "23:59". */
export function formatHHMM(minutesSinceMidnight: number): string {
  const safe = Math.max(0, Math.round(minutesSinceMidnight));
  const h = Math.floor(safe / 60) % 24;
  const m = safe % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Render a delta in minutes (target − now) as user-facing relative
 *  time: 'now', 'in 12 min', 'in 1h 30m', '3 min ago'.
 *  Pure string formatter — callers decide whether to show the
 *  clock time alongside (in a dedicated chip or column), so this
 *  function never repeats the absolute time. Shared by the
 *  schedule view, the vehicle card, and the map popup. */
export function formatRelativeMin(deltaMin: number): string {
  if (deltaMin <= -1) {
    const m = -deltaMin;
    return `${m} min ago`;
  }
  if (deltaMin < 1) return 'now';
  if (deltaMin < 60) return `in ${deltaMin} min`;
  const h = Math.floor(deltaMin / 60);
  const m = deltaMin % 60;
  return m === 0 ? `in ${h}h` : `in ${h}h ${m}m`;
}

/** Per-feed convention: night routes have a short-name ending in 'N'
 *  (Cluj). The schedule view widens the today-window to 24h for these
 *  so post-midnight trips are reachable; the header surfaces a "Night"
 *  chip. Centralised so other feeds that adopt the same convention get
 *  it for free, and so we can swap to a feed-config-driven rule later
 *  without combing through views. */
export function isNightRoute(route: Route): boolean {
  return /n$/i.test(route.shortName);
}
