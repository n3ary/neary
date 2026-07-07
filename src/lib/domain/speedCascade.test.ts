import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FEED_SPEED_CONFIG,
  estimateSegmentSpeed,
  type FeedSpeedConfig,
  type SegmentSpeedInputs,
} from './speedCascade';

const baseSegment = {
  fromLat: 46.77, fromLon: 23.62,
  toLat: 46.77, toLon: 23.625,
};

function inputs(overrides: Partial<SegmentSpeedInputs> = {}): SegmentSpeedInputs {
  return {
    segment: baseSegment,
    segmentDistanceFromVehicleM: 0,
    todBucket: 'offpeak',
    feedConfig: DEFAULT_FEED_SPEED_CONFIG,
    ...overrides,
  };
}

describe('estimateSegmentSpeed — cascade tiers', () => {
  describe('Tier 1: vehicle.speed', () => {
    it('uses the bus\'s own reported speed on the current segment when moving', () => {
      const out = estimateSegmentSpeed(inputs({
        vehicle: { lat: 46.77, lon: 23.62, speedMs: 8 },
      }));
      expect(out.source).toBe('vehicle');
      expect(out.kmh).toBeCloseTo(28.8, 5);
      expect(out.confidence).toBe('high');
    });

    it('skips tier 1 when the bus is below the stopped threshold (≤ 5 km/h)', () => {
      const out = estimateSegmentSpeed(inputs({
        vehicle: { lat: 46.77, lon: 23.62, speedMs: 1 },
      }));
      expect(out.source).not.toBe('vehicle');
    });

    it('skips tier 1 when the segment is beyond the near distance (≥ 500 m)', () => {
      const out = estimateSegmentSpeed(inputs({
        vehicle: { lat: 46.77, lon: 23.62, speedMs: 8 },
        segmentDistanceFromVehicleM: 700,
      }));
      expect(out.source).not.toBe('vehicle');
    });
  });

  describe('Tier 2: fleet p60', () => {
    it('uses the p60 of nearby fleet speeds 500 m – 2 km out', () => {
      const out = estimateSegmentSpeed(inputs({
        vehicle: { lat: 46.77, lon: 23.62, speedMs: 8, directionId: 0 },
        segmentDistanceFromVehicleM: 1_000,
        nearbyVehicles: [
          // 5 samples, all within 1 km, all moving, all same direction.
          { lat: 46.77, lon: 23.625, speedMs: 4, directionId: 0 },
          { lat: 46.77, lon: 23.626, speedMs: 5, directionId: 0 },
          { lat: 46.77, lon: 23.627, speedMs: 6, directionId: 0 },
          { lat: 46.77, lon: 23.628, speedMs: 7, directionId: 0 },
          { lat: 46.77, lon: 23.629, speedMs: 8, directionId: 0 },
        ],
      }));
      expect(out.source).toBe('fleet');
      // p60 of [14.4, 18, 21.6, 25.2, 28.8] at idx floor(5*0.6)=3 → 25.2
      expect(out.kmh).toBeCloseTo(25.2, 5);
      expect(out.confidence).toBe('high'); // ≥ 5 samples
    });

    it('falls through to tier 3 below the minimum sample count', () => {
      const out = estimateSegmentSpeed(inputs({
        vehicle: { lat: 46.77, lon: 23.62, speedMs: 8, directionId: 0 },
        segmentDistanceFromVehicleM: 1_000,
        nearbyVehicles: [
          { lat: 46.77, lon: 23.625, speedMs: 6, directionId: 0 },
        ], // only 1 sample
      }));
      expect(out.source).toBe('tod');
    });

    it('excludes opposite-direction vehicles', () => {
      const out = estimateSegmentSpeed(inputs({
        vehicle: { lat: 46.77, lon: 23.62, speedMs: 8, directionId: 0 },
        segmentDistanceFromVehicleM: 1_000,
        nearbyVehicles: [
          { lat: 46.77, lon: 23.625, speedMs: 5, directionId: 1 },
          { lat: 46.77, lon: 23.626, speedMs: 6, directionId: 1 },
        ],
      }));
      // Both filtered out → fall through to tier 3.
      expect(out.source).toBe('tod');
    });

    it('excludes stopped vehicles from the average', () => {
      const out = estimateSegmentSpeed(inputs({
        vehicle: { lat: 46.77, lon: 23.62, speedMs: 8, directionId: 0 },
        segmentDistanceFromVehicleM: 1_000,
        nearbyVehicles: [
          { lat: 46.77, lon: 23.625, speedMs: 0.5, directionId: 0 }, // stopped
          { lat: 46.77, lon: 23.626, speedMs: 0.2, directionId: 0 }, // stopped
        ],
      }));
      // Both filtered out → fall through to tier 3.
      expect(out.source).toBe('tod');
    });
  });

  describe('Tier 3: time-of-day', () => {
    it('returns the bucket-appropriate speed', () => {
      expect(estimateSegmentSpeed(inputs({ todBucket: 'peak' })).kmh)
        .toBe(DEFAULT_FEED_SPEED_CONFIG.kmh_peak);
      expect(estimateSegmentSpeed(inputs({ todBucket: 'offpeak' })).kmh)
        .toBe(DEFAULT_FEED_SPEED_CONFIG.kmh_offpeak);
      expect(estimateSegmentSpeed(inputs({ todBucket: 'night' })).kmh)
        .toBe(DEFAULT_FEED_SPEED_CONFIG.kmh_night);
    });

    it('marks confidence as medium', () => {
      expect(estimateSegmentSpeed(inputs({ todBucket: 'peak' })).confidence).toBe('medium');
    });

    it('fires for far segments even with no nearby fleet', () => {
      const out = estimateSegmentSpeed(inputs({
        vehicle: { lat: 46.77, lon: 23.62, speedMs: 8 },
        segmentDistanceFromVehicleM: 3_000, // past mid distance
      }));
      expect(out.source).toBe('tod');
    });
  });

  describe('Tier 4: city-centre interpolation', () => {
    const withCentre: FeedSpeedConfig = {
      ...DEFAULT_FEED_SPEED_CONFIG,
      // Malform TOD so tier 3 fails over to tier 4.
      kmh_peak: NaN, kmh_offpeak: NaN, kmh_night: NaN,
      city_centre: { lat: 46.7712, lon: 23.6236 },
    };
    it('returns kmh_min_city_centre at the centre', () => {
      const out = estimateSegmentSpeed(inputs({
        segment: { fromLat: 46.7712, fromLon: 23.6236, toLat: 46.7712, toLon: 23.6236 },
        feedConfig: withCentre,
      }));
      expect(out.source).toBe('centre');
      expect(out.kmh).toBeCloseTo(withCentre.kmh_min_city_centre, 1);
      expect(out.confidence).toBe('low');
    });
    it('returns kmh_max_outskirts at / beyond the radius', () => {
      // Move segment far enough that midpoint is >= centre_radius_km from centre.
      // 0.3° lat at Cluj ≈ 33 km, well past 20 km radius.
      const out = estimateSegmentSpeed(inputs({
        segment: { fromLat: 47.07, fromLon: 23.6236, toLat: 47.07, toLon: 23.6236 },
        feedConfig: withCentre,
      }));
      expect(out.source).toBe('centre');
      expect(out.kmh).toBeCloseTo(withCentre.kmh_max_outskirts, 1);
    });
    it('is skipped when feed config has no city_centre (default config)', () => {
      // Default config: no city_centre → tier 4 skipped, tier 3 (or tier 5)
      // wins. Cluj defaults have TOD → tier 3 fires.
      const out = estimateSegmentSpeed(inputs());
      expect(out.source).toBe('tod');
    });
  });

  describe('Tier 5: static fallback', () => {
    it('fires only with malformed config (no TOD, no city centre)', () => {
      const malformed: FeedSpeedConfig = {
        kmh_peak: NaN, kmh_offpeak: 0, kmh_night: NaN,
        kmh_min_city_centre: 15, kmh_max_outskirts: 45, centre_radius_km: 20,
      };
      const out = estimateSegmentSpeed(inputs({
        feedConfig: malformed,
        todBucket: 'offpeak',
      }));
      expect(out.source).toBe('static');
      expect(out.confidence).toBe('low');
    });
  });
});
