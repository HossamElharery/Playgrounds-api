import * as ngeohash from 'ngeohash';

export function encodeGeohash(lat: number, lng: number, precision = 9): string {
  return ngeohash.encode(lat, lng, precision);
}

/** Great-circle distance in kilometers. */
export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
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
