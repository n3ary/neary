import { describe, expect, it } from 'vitest';
import {
  predictArrivalAlongShape,
  type PredictArrivalInputs,
} from './predictArrivalAlongShape';
import { DEFAULT_FEED_SPEED_CONFIG } from './speedCascade';

// 10 km east-west shape near Cluj for predictable projections.
const shape10km = [
  { lat: 46.7, lon: 23.6 },
  { lat: 46.7, lon: 23.731 },
];

// 0.131° lon ≈ 10 km at Cluj's latitude.
function lonAt(meters: number): number {
  return 23.6 + 0.131 * (meters / 10_000);
}

function inputs(overrides: Partial<PredictArrivalInputs> = {}): PredictArrivalInputs {
  return {
    vehiclePos: { lat: 46.7, lon: lonAt(2_000) },
    stopPos: { lat: 46.7, lon: lonAt(5_000) },
    polyline: shape10km,
    vehicleSpeedMs: 5,
    todBucket: 'offpeak',
    feedConfig: DEFAULT_FEED_SPEED_CONFIG,
    ...overrides,
  };
}

describe('predictArrivalAlongShape', () => {
  it('uses the vehicle\'s reported speed (cascade tier 1) when moving', () => {
    const out = predictArrivalAlongShape(inputs({ vehicleSpeedMs: 10 }));
    expect(out.source).toBe('vehicle');
    expect(out.minutes).toBeCloseTo(5, 1);
    expect(out.distanceMeters).toBeCloseTo(3_000, -2);
    expect(out.confidence).toBe('high');
  });

  it('falls through to time-of-day when the bus is stopped (speed <= 5 km/h)', () => {
    const out = predictArrivalAlongShape(inputs({ vehicleSpeedMs: 1 }));
    expect(out.source).toBe('tod');
    expect(out.minutes).toBeCloseTo(180 / DEFAULT_FEED_SPEED_CONFIG.kmh_offpeak, 1);
    expect(out.confidence).toBe('medium');
  });

  it('falls through to time-of-day when no vehicle speed is reported', () => {
    const out = predictArrivalAlongShape(inputs({ vehicleSpeedMs: null }));
    expect(out.source).toBe('tod');
  });

  it('picks the peak-hour speed when the TOD bucket is peak', () => {
    const out = predictArrivalAlongShape(inputs({
      vehicleSpeedMs: null,
      todBucket: 'peak',
    }));
    expect(out.source).toBe('tod');
    // 3 km at the peak default → minutes = 180 / kmh_peak
    expect(out.minutes).toBeCloseTo(180 / DEFAULT_FEED_SPEED_CONFIG.kmh_peak, 1);
  });

  it('returns a negative minute count when the vehicle is past the stop', () => {
    const out = predictArrivalAlongShape(inputs({
      vehiclePos: { lat: 46.7, lon: lonAt(7_000) }, // past the 5 km stop
      vehicleSpeedMs: 10,
    }));
    expect(out.minutes).toBeLessThan(0);
    expect(out.distanceMeters).toBeCloseTo(2_000, -2);
  });

  it('downgrades confidence when either projection is off the polyline', () => {
    // Vehicle 1.5 km north of the shape (lat 46.7 + 0.015 ≈ 1.67 km).
    const out = predictArrivalAlongShape(inputs({
      vehiclePos: { lat: 46.715, lon: lonAt(2_000) },
      vehicleSpeedMs: 10,
    }));
    expect(out.source).toBe('vehicle');
    // Tier 1 says 'high', but perpDist > MEDIUM_CONF_PERP_M (150 m)
    // clamps confidence to 'low'.
    expect(out.confidence).toBe('low');
  });

  it('adds dwell time for intermediate stops when provided', () => {
    const out = predictArrivalAlongShape(inputs({
      vehicleSpeedMs: 10,
      dwellStopDistAlongM: [3_000, 4_000, 5_000],
      dwellSecondsPerStop: 20,
    }));
    // Base travel: 3 km at 36 km/h = 5 min.
    // Intermediate dwell: stops at 3 km + 4 km only = 40 s = 0.667 min.
    expect(out.minutes).toBeCloseTo(5 + 40 / 60, 1);
  });

  it('falls back to haversine when the polyline projection wanders via a terminal loop', () => {
    // Synthetic shape with a post-terminus loop: A → stop B → terminal C, then
    // a loop-back D → E running south of A–C. A vehicle physically near B but
    // slightly south projects onto the D → E segment, inflating signedDistM
    // well beyond the haversine distance to B.
    const shapeWithTerminalLoop = [
      { lat: 46.70, lon: 23.60 }, // A: origin
      { lat: 46.70, lon: 23.65 }, // B: stop (distAlongM ~3.8 km)
      { lat: 46.70, lon: 23.70 }, // C: terminal (distAlongM ~7.6 km)
      { lat: 46.69, lon: 23.69 }, // D: loop-back start (south of C)
      { lat: 46.69, lon: 23.60 }, // E: loop-back end (south of A)
    ];

    // |signedDistM| projects to ~7.4 km via D → E; haversine is ~1.8 km.
    // Without the sanity clamp, offpeak tier reads 7.4 / 25 * 60 = 17.7 min.
    // With the clamp, haversine wins: 1.8 / 25 * 60 = 4.3 min.
    const out = predictArrivalAlongShape(inputs({
      vehiclePos: { lat: 46.685, lon: 23.66 },
      polyline: shapeWithTerminalLoop,
      vehicleSpeedMs: 0, // stopped → tier 1 suppressed → TOD offpeak wins
    }));

    expect(out.distanceMeters).toBeLessThan(3_000);
    expect(out.distanceMeters).toBeGreaterThan(1_000);
    expect(out.source).toBe('tod');
    expect(out.minutes).toBeLessThan(8);
  });
});
