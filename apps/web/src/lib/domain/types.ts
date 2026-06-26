/*
 * Domain types — UI-facing shapes used by the composite primitives
 * (RouteBadge, VehicleCard, StationCard) and by the upcoming domain layer
 * (prediction, reconciler, buckets).
 *
 * Vehicle model follows docs/rebuild-v2/vehicles-and-views.md §2. Five kinds
 * describing the *source of position knowledge*:
 *
 *   scheduled     trip in schedule, not yet active, no position yet
 *   predicted     trip should be running per schedule, no live GPS — position
 *                 is interpolated from schedule
 *   live          live GPS, no schedule trip matched
 *   reconciled    live GPS + matched scheduled trip (1 live source)
 *   corroborated  live GPS + matched scheduled trip + ≥2 live sources agree
 */

/** A single transit route as the UI sees it. */
export interface Route {
  id: number;
  /** Short marketing identifier ("24", "M1", "B12"). */
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
  /** True when this scheduled row represents the trip's origin stop
   *  (stop_sequence === first_seq). UI uses this to keep the row at
   *  full opacity even when there's no live match — at the origin the
   *  schedule IS authoritative (the bus hasn't started moving yet, so
   *  there can never be a GPS match before scheduled departure). At
   *  intermediate stops a scheduled (no-GPS) row is faded. */
  isAtTripStart?: boolean;
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

/** Stable per-type accent color used by filter bubbles + any future
 *  per-type chart / map glyph. Picked to read against the app's
 *  surface in both themes without needing per-theme overrides. */
export const VEHICLE_TYPE_COLOR: Record<VehicleType, string> = {
  tram: '#e07b00',        // orange
  metro: '#1565c0',       // blue
  rail: '#c62828',        // deep red
  bus: '#2e7d32',         // green
  ferry: '#00838f',       // teal
  cablecar: '#6a1b9a',    // purple
  gondola: '#6a1b9a',     // purple (shared family with cablecar)
  funicular: '#6a1b9a',   // purple (shared family)
  trolleybus: '#8e24aa',  // magenta
  monorail: '#3949ab',    // indigo
  unknown: '#666666',     // neutral
};

interface VehicleBase {
  id: string;
  route: Route;
  /** Mode of transport. Set by the pipeline from the route's GTFS route_type. */
  type: VehicleType;
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
      /** Scheduled vehicles have no position until they go predicted/live. */
      position?: undefined;
      liveSources?: never;
    })
  | (VehicleBase & {
      kind: 'predicted';
      schedule: ScheduledRun;
      /** Always present and always `predicted-from-schedule`. */
      position: VehiclePosition;
      liveSources?: never;
      /** Which live sources were polled and did NOT see this trip. */
      checkedSources: LiveSource[];
    })
  | (VehicleBase & {
      kind: 'live';
      /** Always present and always `gps`. */
      position: VehiclePosition;
      /** Pure live vehicles have no schedule match yet. */
      schedule?: ScheduledRun;
      /** Always at least one source. */
      liveSources: LiveSource[];
    })
  | (VehicleBase & {
      kind: 'reconciled';
      position: VehiclePosition;
      schedule: ScheduledRun;
      /** Exactly one source. */
      liveSources: LiveSource[];
    })
  | (VehicleBase & {
      kind: 'corroborated';
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

/** Format a scheduled-departure minutes-since-midnight value as "HH:MM". */
export function formatHHMM(minutesSinceMidnight: number): string {
  const safe = Math.max(0, Math.min(24 * 60 - 1, Math.round(minutesSinceMidnight)));
  const h = Math.floor(safe / 60);
  const m = safe % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
