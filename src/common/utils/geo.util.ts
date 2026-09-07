import * as ngeohash from 'ngeohash';
import { Prisma } from '@prisma/client';

export type GeoJsonPolygon = {
  type: 'Polygon';
  coordinates: number[][][];
};

/** Normalize stored district polygon JSON into the explore-search GeoJSON shape. */
export function toSearchBoundary(
  polygon: Prisma.JsonValue | null | undefined,
): GeoJsonPolygon | null {
  if (polygon == null) return null;
  if (Array.isArray(polygon)) {
    return { type: 'Polygon', coordinates: polygon as number[][][] };
  }
  if (
    typeof polygon === 'object' &&
    'type' in polygon &&
    (polygon as { type?: string }).type === 'Polygon' &&
    'coordinates' in polygon
  ) {
    return polygon as GeoJsonPolygon;
  }
  return null;
}

export function encodeGeohash(lat: number, lng: number, precision = 9): string {
  return ngeohash.encode(lat, lng, precision);
}

/** Great-circle distance in kilometers. */
export function haversineKm(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Geohash prefixes covering a bounding box, for a coarse pre-filter before Haversine refinement. */
export function geohashPrefixesForBbox(
  west: number,
  south: number,
  east: number,
  north: number,
  precision = 4,
): string[] {
  const prefixes = new Set<string>();
  const latStep = (north - south) / 4 || 0.01;
  const lngStep = (east - west) / 4 || 0.01;
  for (let lat = south; lat <= north; lat += latStep) {
    for (let lng = west; lng <= east; lng += lngStep) {
      prefixes.add(ngeohash.encode(lat, lng, precision));
    }
  }
  return Array.from(prefixes);
}

/** west, south, east, north — cheap SQL pre-filter before Haversine. */
export function bboxFromRadiusKm(
  lat: number,
  lng: number,
  radiusKm: number,
): [number, number, number, number] {
  const latDelta = radiusKm / 110.574;
  const cos = Math.cos((lat * Math.PI) / 180);
  const lngDelta = radiusKm / (111.32 * (Math.abs(cos) < 0.01 ? 0.01 : cos));
  return [lng - lngDelta, lat - latDelta, lng + lngDelta, lat + latDelta];
}

export type PinLike = { lat: number; lng: number };

export type GeoCluster = {
  lat: number;
  lng: number;
  count: number;
  bbox: [number, number, number, number];
};

/**
 * When a viewport has more pins than `cap`, collapse dense geohash cells into
 * cluster bubbles so the payload stays map-sized (Airbnb-style).
 */
export function clusterByGeohash<T extends PinLike>(
  points: T[],
  cap = 500,
  precision = 5,
): { pins: T[]; clusters: GeoCluster[] } {
  if (points.length <= cap) return { pins: points, clusters: [] };

  const buckets = new Map<string, T[]>();
  for (const point of points) {
    const key = encodeGeohash(point.lat, point.lng, precision);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(point);
    else buckets.set(key, [point]);
  }

  const pins: T[] = [];
  const clusters: GeoCluster[] = [];
  for (const group of buckets.values()) {
    if (group.length < 4 && pins.length + group.length <= cap) {
      pins.push(...group);
      continue;
    }
    const lat = group.reduce((sum, p) => sum + p.lat, 0) / group.length;
    const lng = group.reduce((sum, p) => sum + p.lng, 0) / group.length;
    const lats = group.map((p) => p.lat);
    const lngs = group.map((p) => p.lng);
    clusters.push({
      lat,
      lng,
      count: group.length,
      bbox: [
        Math.min(...lngs),
        Math.min(...lats),
        Math.max(...lngs),
        Math.max(...lats),
      ],
    });
  }
  return { pins: pins.slice(0, cap), clusters };
}
