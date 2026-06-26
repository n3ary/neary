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
}

interface VehicleBase {
  id: string;
  route: Route;
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
