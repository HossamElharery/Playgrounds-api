import { haversineKm } from '../../common/utils/geo.util';

export interface CatalogDistrict {
  id: string;
  slug: string | null;
  nameAr: string;
  nameEn: string;
  governorateId: string;
  lat: number | null;
  lng: number | null;
}

export const ROLLUP_MAX_KM = 3;

export function isNamedArea(district: Pick<CatalogDistrict, 'slug'>): boolean {
  return !!district.slug && !district.slug.startsWith('cod-');
}

const ORDINALS = /(?:^|\s)(?:قسم|مركز|حي|اول|أول|ثان|ثاني|ثالث|رابع|خامس)(?=\s|$)/g;

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
