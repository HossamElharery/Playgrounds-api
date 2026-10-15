import { haversineKm } from '../../common/utils/geo.util';

/**
 * The geo catalog has two kinds of district rows:
 * - ~120 named areas people search for ("مدينة نصر", "Maadi", slug `nasr-city`);
 * - ~6,000 census sub-areas (slug `cod-…`, name "<shiakha> — <qism>", e.g. "الاستاد — قسم ثان مدينة نصر").
 * Venues can be filed under either. Public pages (local landings, the explore filter, breadcrumbs)
 * only speak in named areas, so every census row is rolled up to the named area it belongs to.
 */
export interface CatalogDistrict {
  id: string;
  slug: string | null;
  nameAr: string;
  nameEn: string;
  governorateId: string;
  lat: number | null;
  lng: number | null;
}

/** A census sub-area farther than this from every named area's centre stays governorate-only. */
export const ROLLUP_MAX_KM = 3;

export function isNamedArea(district: Pick<CatalogDistrict, 'slug'>): boolean {
  return !!district.slug && !district.slug.startsWith('cod-');
}

const ORDINALS = /(?:^|\s)(?:قسم|مركز|حي|اول|أول|ثان|ثاني|ثالث|رابع|خامس)(?=\s|$)/g;

/** Compares Arabic place names regardless of spacing, hamza/ta-marbuta spelling and "قسم أول/ثان" prefixes. */
export function normalizePlaceName(value: string): string {
  return value
    .replace(/[ً-ْـ]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(ORDINALS, ' ')
    .replace(/[^\p{L}\p{N}]/gu, '')
    .toLowerCase();
}

/**
 * Maps every district id to the id of its named area (named areas map to themselves).
 * Census rows are matched by the qism in their name first, then by distance; anything
 * else is left out, so it only counts towards its governorate.
 */
export function buildAreaRollup(districts: CatalogDistrict[]): Map<string, string> {
  const named = districts.filter(isNamedArea);
  const byGovernorate = new Map<string, { area: CatalogDistrict; key: string }[]>();
  for (const area of named) {
    const list = byGovernorate.get(area.governorateId) ?? [];
    list.push({ area, key: normalizePlaceName(area.nameAr) });
    byGovernorate.set(area.governorateId, list);
  }
  for (const list of byGovernorate.values()) list.sort((a, b) => b.key.length - a.key.length);

  const rollup = new Map<string, string>();
  for (const area of named) rollup.set(area.id, area.id);
  for (const district of districts) {
    if (isNamedArea(district)) continue;
    const candidates = byGovernorate.get(district.governorateId) ?? [];
    const parts = district.nameAr.split('—');
    const qism = normalizePlaceName(parts[parts.length - 1] ?? '');
    const byName = qism ? candidates.find(({ key }) => key.length >= 3 && qism.includes(key)) : undefined;
    if (byName) {
      rollup.set(district.id, byName.area.id);
      continue;
    }
    if (district.lat == null || district.lng == null) continue;
    let best: { id: string; km: number } | null = null;
    for (const { area } of candidates) {
      if (area.lat == null || area.lng == null) continue;
      const km = haversineKm(district.lat, district.lng, area.lat, area.lng);
      if (km <= ROLLUP_MAX_KM && (!best || km < best.km)) best = { id: area.id, km };
    }
    if (best) rollup.set(district.id, best.id);
  }
  return rollup;
}
