/*
 * Domain types — minimal UI-facing shapes used by the composite primitives
 * (RouteBadge, VehicleCard, StationCard) so they don't depend on the real
 * GTFS / Tranzy data layer yet.
 *
 * These are intentionally narrow: only the fields the UI renders. The real
 * domain layer (Phase 4) will expose richer entities and adapt them down to
 * these shapes via mappers, so component code never changes when the source
 * shape moves.
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

/** GPS fix snapshot. */
export interface GpsFix {
  lat: number;
  lon: number;
  /** Unix ms timestamp. */
  observedAt: number;
}

/** A scheduled run on a route, used to attach schedule context to a vehicle. */
export interface ScheduledRun {
  tripId: string;
  /** Minutes since local midnight. */
  scheduledDeparture: number;
  headsign?: string;
}

/**
 * Discriminated union for vehicle taxonomy (plan §3). Every view uses the same
 * union, so the visual encoding (border, opacity, badge) lives in exactly one
 * place (VehicleCard) and rendering consistency is structural.
 *
 *   live          GPS visible, no schedule match (or none possible).
 *   live-matched  GPS visible AND matched to a scheduled run.
 *   ghost         Scheduled run is current, but GPS is missing.
 *   scheduled     Schedule-only (no live data, or live not enabled).
 */
export type Vehicle =
  | { kind: 'live'; id: string; route: Route; gps: GpsFix; eta?: number; headsign?: string }
  | { kind: 'live-matched'; id: string; route: Route; gps: GpsFix; schedule: ScheduledRun; eta?: number; headsign?: string }
  | { kind: 'ghost'; id: string; route: Route; schedule: ScheduledRun; lastSeenGps?: GpsFix; headsign?: string }
  | { kind: 'scheduled'; id: string; route: Route; schedule: ScheduledRun; headsign?: string };

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
