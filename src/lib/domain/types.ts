// Domain shapes (Vehicle, Route, Station, schedule, ETAs). UI consumes from here; pipeline owns internal workers.

import type { LatLon } from '@n3ary/gtfs-spec/shape';

/** A route as the UI sees it. */
export interface Route {
  /** GTFS route_id, free-form text per spec. Kept as string so non-numeric ids ('102L') round-trip through URLs, localStorage, set membership. */
  id: string;
  /** GTFS route_short_name ('24', 'M1', 'B12'). What users read; never use it as an identifier. */
  shortName: string;
  /** GTFS route_long_name. Optional per spec when route_short_name is set. */
  longName?: string;
  /** GTFS route_desc one-liner ("express to airport"). Undefined on older feeds. */
  description?: string;
  /** Hex color with leading '#'. */
  color: string;
  /** Optional explicit foreground; if omitted we compute a contrast color. */
  textColor?: string;
  /** GTFS routes.route_type. Optional so producers that don't populate it typecheck. */
  type?: VehicleType;
  /** True when the feed has at least one trip on this route with a usable arrival_time (schedule view has something). Undefined = assume true (back-compat). False = adapter-emitted live-only fallback trips with empty stop_times (`..._NT001`); UI gates schedule buttons on this. */
  hasSchedule?: boolean;
  /** Producer-extension tag ids from `_route_tags.txt` (1:many per route, e.g. `['night', 'metroline']`). Undefined on feeds that don't ship the producer extension. */
  tags?: string[];
  /** Public GTFS `networks.txt` ids the route belongs to. 1:1 by
   *  `route_id` per the public spec, so this is a single-element
   *  array in practice; kept as `string[]` for forward-compat
   *  with any future spec change. Undefined on older cached blobs
   *  predating the spec's adoption. */
  networks?: string[];
}

/** A network / service category from GTFS `networks.txt`. */
export interface Network {
  id: string;
  name: string;
  /** Hex chip color (with leading '#'), modal route_color of routes in this network, collision-resolved. */
  color: string;
}

/** A tag from the feed's producer-extension `_route_tags` table (1:many per route). */
export interface RouteTag {
  /** Stable tag id (`night`, `metroline`, `festival`, `airport`, `special` for the cluj adapter). */
  id: string;
  /** Human label (denormalized into the row so consumers don't have to join). */
  name: string;
  /** TAGS-declaration index; sort ASCENDING for stable badge ordering. The cluj adapter encodes 0=night, 1=metroline, 2=airport, 3=festival, 4=special. */
  priority: number;
  /** Lucide-svelte slug the chip renders (e.g. `moon`, `map-pin`, `plane`, `music`, `zap`). Owned by the adapter — the app just looks it up in `tagIcons`. Undefined when the adapter didn't declare an icon for this tag; the consumer falls back to a default. */
  icon?: string;
  /** Optional 6-char hex (no leading `#`) from the adapter's `_route_tags.color` column — the chip background. Owned by the adapter (the `TAGS` array in `routeCategory.ts`); hand-picked per the operator's brand. Undefined on older cached blobs that pre-date the color column; the consumer falls back to the default chip color in that case. Foreground contrast is derived generically via `pickContrastingText` (all 5 cluj hand-picked colors are dark enough for `#fff`). */
  color?: string;
}

/** A station / stop as the UI sees it. */
export interface Station {
  /** GTFS stop_id, free-form text per spec. Same convention as Route.id — string so alphanumeric ids round-trip. */
  id: string;
  name: string;
  /** Distance from the user in meters. Undefined for non-located contexts. */
  distance?: number;
  lat?: number;
  lon?: number;
}

/** GPS fix snapshot — used historically; kept for compat. */
export interface GpsFix extends LatLon {
  /** Unix ms timestamp. */
  observedAt: number;
}

/** Which live feed produced an observation. Union kept as a type alias so a future second-source identifier can be added without churning call sites. */
export type LiveSource = 'gtfs-rt';

/** Reconciler-derived confidence in the vehicle's stated position. */
export type Confidence = 'high' | 'medium' | 'low';

/** Vehicle position with provenance, so the UI can choose how much to trust it without re-deriving from kind. */
export interface VehiclePosition extends LatLon {
  /** Where this position came from. */
  source: 'gps' | 'predicted-from-schedule' | 'predicted-from-gps';
  /** Unix ms — GPS fix time for `source=gps`, prediction time otherwise. */
  asOf: number;
  /** Reported instantaneous speed in m/s when the live source carries it. null/absent falls back to config-driven average. */
  speedMs?: number | null;
}

/** ETA at the target stop. Negative minutes = already passed (departed bucket). */
export interface VehicleEta {
  distanceMeters: number;
  minutes: number;
  confidence: Confidence;
}

/** A scheduled run on a route, attached to a vehicle. Departure/arrival times are minutes since local midnight at the *target stop* the vehicle is rendered for — never the trip start time. */
export interface ScheduledRun {
  tripId: string;
  /** Minutes since local midnight at the target stop. */
  scheduledDeparture: number;
  /** Arrival time at the target stop, if distinct from departure. Same units. */
  scheduledArrival?: number;
  headsign?: string;
  /** GTFS trips.direction_id (0, 1) or -1 if the feed doesn't populate it. Used by the reconciler as part of the live-match key. */
  directionId?: 0 | 1 | -1;
  /** True when this row represents the trip's FIRST stop (stop_sequence === first_seq). Row's POV — this stop is the trip's origin. UI keeps the row at full opacity even without a live match: at origin the schedule IS authoritative (bus hasn't started, no GPS can match yet). */
  isFirstStop?: boolean;
  /** True when this stop is the trip's LAST stop (stop_sequence === last_seq). Row's POV — this stop is the terminus. Suppresses upcoming-stops expansion; row is drop-off-only regardless of pickup_type. */
  isLastStop?: boolean;
  /** Phase of this trip in its daily route lifecycle relative to `now`. Set on every emitted row (not only origin rows) — UI consumers (drop-off filter, action-button gates) need the phase at terminus and midpoints. Recomputed on every snapshot; undefined only when tripStartMin is unknown. */
  tripPhase?: 'next' | 'last' | 'on-route' | 'later';
  /** Minutes since local midnight at the trip's FIRST stop (origin departure). Reconciler matches live observations by `(routeId, directionId, tripStartMin)` with adaptive tolerance — independent of trip_id, which can differ between static GTFS and RT. */
  tripStartMin?: number;
}

/** Vehicle type — orthogonal to `kind` (which is about source of position knowledge). Maps from GTFS routes.route_type. */
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

/** Map GTFS route_type integer to a VehicleType. Unknown values fall back to 'bus' (HVT extended 700..1799 is mostly bus). */
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
      // HVT extended ranges: 100..199=Rail 700..899=Bus 900..999=Tram 1200..1299=Ferry 1400..1499=Funicular
      if (routeType >= 100 && routeType < 200) return 'rail';
      if (routeType >= 700 && routeType < 900) return 'bus';
      if (routeType >= 900 && routeType < 1000) return 'tram';
      if (routeType >= 1200 && routeType < 1300) return 'ferry';
      if (routeType >= 1400 && routeType < 1500) return 'funicular';
      return 'bus';
  }
}

/** Title-case label for a VehicleType. */
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
  /** GTFS trip_id this Vehicle represents. Set from static schedule (scheduled/tracked/verified) or live observation (gps-only). applyGpsEta uses this directly for shape lookup without reaching into schedule.tripId. */
  tripId?: string;
  /** GTFS direction_id (0, 1) or -1 when unknown. Fallback shape-lookup key when the trip's own shape isn't available (route-level shapes are shared across trips on the same (route, direction)). */
  directionId?: 0 | 1 | -1;
  /** Resolved by the reconciler from schedule or live. */
  headsign?: string;
  eta?: VehicleEta;
  confidence: Confidence;
  /** True when this stop is marked drop-off-only for this trip (GTFS stop_times.pickup_type = 1). UI hides by default unless userPrefs.showDropOffOnly. Only meaningful in station-view context. */
  dropOffOnly?: boolean;
}

export type Vehicle =
  | (VehicleBase & {
      kind: 'scheduled';
      schedule: ScheduledRun;
      /** Interpolated position when the trip is running per schedule.tripPhase (`last`/`on-route`) but no live match yet. Absent for trips that haven't started (`next`/`later`). */
      position?: VehiclePosition;
      liveSources?: never;
    })
  | (VehicleBase & {
      kind: 'gps-only';
      /** Always present and always `gps`. */
      position: VehiclePosition;
      /** Pure live vehicles have no schedule match yet. */
      schedule?: ScheduledRun;
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

/** Fallback `route_color` when a row arrives without one. The cluj
 *  adapter's `route-colors.ts` is contractually supposed to ensure no
 *  row reaches the DB with a missing color (placeholder substitution +
 *  OKLCh modal-collision resolution guarantees every row_type gets a
 *  color), so this is dead code for cluj. It still fires for older
 *  cached blobs predating the fixup and for any future adapter that
 *  doesn't run the same pipeline. Matches the producer-side
 *  `ANCHOR_COLOR` in n3ary/gtfs-adapters so the two sides can't drift. */
export const MISSING_ROUTE_COLOR = '#F3513C';

/** Pick a black/white foreground that has enough contrast against a hex background. sRGB relative luminance (not perceptual lightness) — good enough for transit palettes which never sit near the boundary. */
export function pickContrastingText(hex: string): '#000' | '#fff' {
  const c = hex.replace('#', '');
  if (c.length !== 6) return '#000';
  const r = parseInt(c.substring(0, 2), 16);
  const g = parseInt(c.substring(2, 4), 16);
  const b = parseInt(c.substring(4, 6), 16);
  // Relative luminance approximation (faster than full sRGB linearization)
  const L = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return L > 0.6 ? '#000' : '#fff';
}

/** Format minutes-since-midnight as "HH:MM". Wraps the hour modulo 24 so GTFS extended times ("25:30" for night-route past-midnight) render as wall-clock "01:30" rather than "23:59". */
export function formatHHMM(minutesSinceMidnight: number): string {
  const safe = Math.max(0, Math.round(minutesSinceMidnight));
  const h = Math.floor(safe / 60) % 24;
  const m = safe % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Render a delta in minutes as user-facing relative time. Pure string — callers decide whether to show clock time alongside. Shared by schedule, vehicle card, map popup. */
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

/** True when the route belongs to the 'night' tag or the 'night' network.
 *  Falls back to legacy short-name heuristic for feeds that pre-date
 *  both _route_tags and networks.txt support. */
export function isNightRoute(route: Route): boolean {
  if (route.tags?.includes('night')) return true;
  if (route.networks?.includes('night')) return true;
  return /n$/i.test(route.shortName);
}

/** Natural-sort comparator for route short-names. Replaces a two-branch comparator (numeric-when-both-pure-else-lexical) that produced non-transitive ordering when one name was pure-digit and another wasn't (compare(14, 24B), compare(24B, 7), compare(14, 7) disagreed → JS sort returned arbitrary output). */
const PURE_DIGITS = /^\d+$/;
const NATURAL_RUN = /(\d+|\D+)/g;

export function compareRouteShortName(a: string, b: string): number {
  if (a === b) return 0;
  // Fast path: both pure-digit names (the majority of transit feeds) — avoids regex tokenisation + allocation.
  if (PURE_DIGITS.test(a) && PURE_DIGITS.test(b)) return Number(a) - Number(b);
  const ap = a.match(NATURAL_RUN) ?? [a];
  const bp = b.match(NATURAL_RUN) ?? [b];
  const n = Math.min(ap.length, bp.length);
  for (let i = 0; i < n; i++) {
    const an = Number(ap[i]);
    const bn = Number(bp[i]);
    if (Number.isFinite(an) && Number.isFinite(bn)) {
      if (an !== bn) return an - bn;
    } else {
      const c = ap[i].localeCompare(bp[i]);
      if (c !== 0) return c;
    }
  }
  return ap.length - bp.length;
}
