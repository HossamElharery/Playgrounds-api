import { haversineKm } from '../../common/utils/geo.util';

/**
 * Rules for the generated local landing pages (/egypt/cairo/nasr-city/football…).
 * A page is generated for any place that exists, but it is only offered to search
 * engines (index + sitemap) when it has enough real inventory to be useful on its own.
 */

/** Fewer listings than this is a thin page: it stays reachable for people but is `noindex`. */
export const MIN_INDEXABLE_VENUES = 2;
/** Nearby areas listed on an area page. */
export const NEARBY_AREAS = 6;
export const NEARBY_MAX_KM = 25;

/** Public URL slug per country code. Only countries listed here get local landing pages. */
export const COUNTRY_SLUGS: Record<string, string> = { EG: 'egypt' };
export const countryCodeForSlug = (slug: string): string | undefined =>
  Object.entries(COUNTRY_SLUGS).find(([, value]) => value === slug)?.[0];

export type LandingKind = 'country' | 'governorate' | 'governorate-sport' | 'area' | 'area-sport';

export type IndexReason = 'ok' | 'thin' | 'no-photos' | 'same-as-parent';

export interface LandingVenueFacts {
  id: string;
  priceFromAmount: number | null;
  ratingAvg: number;
  ratingCount: number;
  instantBook: boolean;
  hasPhoto: boolean;
  sportSlugs: string[];
  hours: HoursSummary | null;
}

export interface HoursSummary {
  openDays: number;
  /** Earliest opening over the week, "HH:mm". */
  earliestOpen: string;
  /** Latest closing over the week as shown on a clock ("24:00" = midnight, "02:00" = 2 am next day). */
  latestClose: string;
  /** Minutes after the opening day's midnight, so 02:00 next day (1560) ranks after 23:00 (1380). */
  latestCloseRank: number;
  /** Open until midnight or later on at least one day. */
  lateNight: boolean;
}

export interface LandingStats {
  venueCount: number;
  priceMin: number | null;
  priceMax: number | null;
  priceMedian: number | null;
  ratingAvg: number | null;
  reviewCount: number;
  instantBookCount: number;
  lateNightCount: number;
  openDailyCount: number;
  earliestOpen: string | null;
  latestClose: string | null;
}

const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

export function summarizeHours(raw: unknown): HoursSummary | null {
  if (!raw || typeof raw !== 'object') return null;
  let openDays = 0;
  let earliestOpen = '';
  let latestClose = '';
  let latestCloseRank = -1;
  let lateNight = false;
  for (let day = 0; day <= 6; day += 1) {
    const entry = (raw as Record<string, { closed?: boolean; open?: string; close?: string } | undefined>)[String(day)];
    if (!entry || entry.closed || !entry.open || !entry.close) continue;
    openDays += 1;
    if (!earliestOpen || entry.open < earliestOpen) earliestOpen = entry.open;
    const overnight = entry.close < entry.open;
    const rank = minutes(entry.close) + (overnight ? 24 * 60 : 0);
    if (rank > latestCloseRank) {
      latestCloseRank = rank;
      latestClose = entry.close;
    }
    if (rank >= 24 * 60) lateNight = true;
  }
  if (!openDays) return null;
  return { openDays, earliestOpen, latestClose, latestCloseRank, lateNight };
}

export function landingStats(venues: LandingVenueFacts[]): LandingStats {
  const prices = venues
    .map((v) => v.priceFromAmount)
    .filter((p): p is number => typeof p === 'number' && p > 0)
    .sort((a, b) => a - b);
  const rated = venues.filter((v) => v.ratingCount > 0);
  const reviewCount = rated.reduce((sum, v) => sum + v.ratingCount, 0);
  const ratingAvg = reviewCount
    ? Math.round((rated.reduce((sum, v) => sum + v.ratingAvg * v.ratingCount, 0) / reviewCount) * 10) / 10
    : null;
  const hours = venues.map((v) => v.hours).filter((h): h is HoursSummary => !!h);
  const latest = hours.reduce<HoursSummary | null>((best, h) => (!best || h.latestCloseRank > best.latestCloseRank ? h : best), null);
  return {
    venueCount: venues.length,
    priceMin: prices[0] ?? null,
    priceMax: prices.at(-1) ?? null,
    priceMedian: prices.length ? prices[Math.floor((prices.length - 1) / 2)] : null,
    ratingAvg,
    reviewCount,
    instantBookCount: venues.filter((v) => v.instantBook).length,
    lateNightCount: hours.filter((h) => h.lateNight).length,
    openDailyCount: hours.filter((h) => h.openDays === 7).length,
    earliestOpen: hours.map((h) => h.earliestOpen).sort()[0] ?? null,
    latestClose: latest?.latestClose ?? null,
  };
}

/**
 * Index decision. `parentCount` is the listing count of the broader page this one narrows
 * (area → area-sport, governorate → governorate-sport); `parentSportCount` how many sports
 * that broader page has. A sport page that lists exactly its parent's venues because the
 * parent only has that one sport adds nothing, so it defers to the parent.
 */
export function indexDecision(input: {
  kind: LandingKind;
  venues: LandingVenueFacts[];
  parentCount?: number;
  parentSportCount?: number;
}): { indexable: boolean; reason: IndexReason } {
  const { kind, venues } = input;
  const min = kind === 'country' ? 1 : MIN_INDEXABLE_VENUES;
  if (venues.length < min) return { indexable: false, reason: 'thin' };
  if (!venues.some((v) => v.hasPhoto)) return { indexable: false, reason: 'no-photos' };
  if (
    (kind === 'area-sport' || kind === 'governorate-sport') &&
    input.parentCount === venues.length &&
    input.parentSportCount === 1
  ) {
    return { indexable: false, reason: 'same-as-parent' };
  }
  return { indexable: true, reason: 'ok' };
}

export interface PlacePoint {
  id: string;
  lat: number | null;
  lng: number | null;
}

/** Closest places to `origin` (by centre), excluding itself, within NEARBY_MAX_KM. */
export function nearestPlaces<T extends PlacePoint>(origin: PlacePoint, places: T[], limit = NEARBY_AREAS): (T & { distanceKm: number })[] {
  if (origin.lat == null || origin.lng == null) return [];
  return places
    .filter((p) => p.id !== origin.id && p.lat != null && p.lng != null)
    .map((p) => ({ ...p, distanceKm: Math.round(haversineKm(origin.lat!, origin.lng!, p.lat!, p.lng!) * 10) / 10 }))
    .filter((p) => p.distanceKm <= NEARBY_MAX_KM)
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, limit);
}
