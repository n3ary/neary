import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseVehiclePositions, resolveDirectionId } from './gtfsRtClient';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(join(__dirname, '__fixtures__/cluj-vehicle-positions.bin'));

describe('parseVehiclePositions', () => {
  it('decodes a real Cluj VehiclePositions snapshot', () => {
    const snap = parseVehiclePositions(new Uint8Array(fixture));
    expect(snap.feedTimestampMs).toBeGreaterThan(0);
    expect(snap.vehicles.length).toBeGreaterThan(10);

    const v = snap.vehicles[0];
    expect(v.source).toBe('gtfs-rt');
    expect(typeof v.lat).toBe('number');
    expect(typeof v.lon).toBe('number');
    // Cluj is around 46.7, 23.6 — sanity-check the snapshot is in-region.
    expect(v.lat).toBeGreaterThan(46);
    expect(v.lat).toBeLessThan(47);
    expect(v.lon).toBeGreaterThan(23);
    expect(v.lon).toBeLessThan(24);
  });

  it('emits a trip_id that looks GTFS-canonical when the feed assigns one', () => {
    const snap = parseVehiclePositions(new Uint8Array(fixture));
    // Most entries should have a non-empty trip_id; some may be deadheading.
    const withTrip = snap.vehicles.filter((v) => v.tripId.length > 0);
    expect(withTrip.length).toBeGreaterThan(0);
    // GTFS-RT trip_ids for Cluj look like '45_1_LV_9_0721' (route_dir_service_block_starttime).
    expect(withTrip[0].tripId).toMatch(/^\d+_\d+_/);
  });
});

describe('resolveDirectionId', () => {
  it('prefers the trip_id-encoded direction over a claimed value', () => {
    // Observed in Cluj: feed sets directionId=0 for every vehicle, but
    // the real direction lives in the trip_id second segment.
    expect(resolveDirectionId(0, '13_1_LV_70_1448')).toBe(1);
    expect(resolveDirectionId(0, '13_0_LV_79_1504')).toBe(0);
  });

  it('falls back to the claimed value when trip_id has no parseable dir', () => {
    expect(resolveDirectionId(1, 'opaque-trip')).toBe(1);
    expect(resolveDirectionId(0, '')).toBe(0);
  });

  it('returns -1 when both sources are unavailable', () => {
    expect(resolveDirectionId(null, 'opaque')).toBe(-1);
  });

  it('ignores trip_id segments that aren’t 0/1', () => {
    expect(resolveDirectionId(1, '13_7_LV_99_1500')).toBe(1);
  });
});
