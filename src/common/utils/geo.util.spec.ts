import {
  bboxFromRadiusKm,
  clusterByGeohash,
  encodeGeohash,
  geohashPrefixesForBbox,
  haversineKm,
  pointInPolygon,
} from './geo.util';

describe('geo.util', () => {
  it('computes zero distance for the same point', () => {
    expect(haversineKm(30.05, 31.23, 30.05, 31.23)).toBeCloseTo(0, 5);
  });

  it('computes a plausible distance between two Cairo districts', () => {
    // Nasr City to Maadi is roughly 15-20km
    const km = haversineKm(30.0626, 31.3428, 29.9603, 31.2569);
    expect(km).toBeGreaterThan(10);
    expect(km).toBeLessThan(25);
  });

  it('produces a stable geohash for the same coordinates', () => {
    expect(encodeGeohash(30.05, 31.23)).toBe(encodeGeohash(30.05, 31.23));
  });

  it('builds a bbox that contains the center point', () => {
    const [west, south, east, north] = bboxFromRadiusKm(30.05, 31.23, 5);
    expect(west).toBeLessThan(31.23);
    expect(east).toBeGreaterThan(31.23);
    expect(south).toBeLessThan(30.05);
    expect(north).toBeGreaterThan(30.05);
  });

  it('covers every venue geohash inside a wide bbox without sampling gaps', () => {
    const prefixes = geohashPrefixesForBbox(30, 22, 34, 32, 4, 32);
    const cairo = encodeGeohash(30.073113, 31.326339);
    const komOmbo = encodeGeohash(24.47448, 32.939454);

    expect(prefixes.length).toBeGreaterThan(0);
    expect(prefixes.length).toBeLessThanOrEqual(32);
    expect(prefixes.some((prefix) => cairo.startsWith(prefix))).toBe(true);
    expect(prefixes.some((prefix) => komOmbo.startsWith(prefix))).toBe(true);
  });

  it('returns a complete coarse cover for a very large viewport', () => {
    const prefixes = geohashPrefixesForBbox(-180, -85, 180, 85, 4, 32);
    const cairo = encodeGeohash(30.073113, 31.326339);

    expect(prefixes).toHaveLength(32);
    expect(prefixes.some((prefix) => cairo.startsWith(prefix))).toBe(true);
  });

  it('detects a point inside a simple square polygon', () => {
    const square = {
      type: 'Polygon' as const,
      coordinates: [
        [
          [31.0, 30.0],
          [31.5, 30.0],
          [31.5, 30.2],
          [31.0, 30.2],
          [31.0, 30.0],
        ],
      ],
    };
    expect(pointInPolygon(31.25, 30.1, square)).toBe(true);
    expect(pointInPolygon(32.0, 30.1, square)).toBe(false);
  });

  it('clusters dense pins instead of returning every point past the cap', () => {
    const points = Array.from({ length: 40 }, (_, i) => ({
      lat: 30.05 + (i % 8) * 0.0002,
      lng: 31.23 + Math.floor(i / 8) * 0.0002,
    }));
    const { pins, clusters } = clusterByGeohash(points, 10, 6);
    expect(pins.length + clusters.reduce((n, c) => n + c.count, 0)).toBeGreaterThanOrEqual(
      10,
    );
    expect(clusters.length).toBeGreaterThan(0);
  });
});
