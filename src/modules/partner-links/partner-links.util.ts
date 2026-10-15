import { summarizeHours, type HoursSummary } from '../seo/local-landing.util';

/** What a partner link can lead to. Bookings join this list once VENUE_BOOKING_ENABLED is back on. */
export const PARTNER_EVENTS = ['landing', 'contact_click'] as const;
export type PartnerEvent = (typeof PARTNER_EVENTS)[number];

/** AnalyticsEvent.name for each partner event (names are indexed with createdAt). */
export const PARTNER_EVENT_NAME: Record<PartnerEvent, string> = {
  landing: 'partner.landing',
  contact_click: 'partner.contact_click',
};

export interface PartnerStatRow {
  name: string;
  medium: string | null;
  total: number;
  last30: number;
}

export interface PartnerStats {
  total: { landings: number; contactClicks: number };
  last30: { landings: number; contactClicks: number };
  byMedium: { medium: string; landings: number; contactClicks: number }[];
}

/** Folds grouped SQL rows into the owner page's counters, busiest medium first. */
export function foldPartnerStats(rows: PartnerStatRow[]): PartnerStats {
  const stats: PartnerStats = {
    total: { landings: 0, contactClicks: 0 },
    last30: { landings: 0, contactClicks: 0 },
    byMedium: [],
  };
  const media = new Map<
    string,
    { medium: string; landings: number; contactClicks: number }
  >();
  for (const row of rows) {
    const key =
      row.name === PARTNER_EVENT_NAME.contact_click
        ? 'contactClicks'
        : row.name === PARTNER_EVENT_NAME.landing
          ? 'landings'
          : null;
    if (!key) continue;
    const total = Number(row.total) || 0;
    stats.total[key] += total;
    stats.last30[key] += Number(row.last30) || 0;
    const medium = row.medium?.trim().toLowerCase() || 'other';
    const entry = media.get(medium) ?? {
      medium,
      landings: 0,
      contactClicks: 0,
    };
    entry[key] += total;
    media.set(medium, entry);
  }
  stats.byMedium = [...media.values()].sort(
    (a, b) => b.landings + b.contactClicks - (a.landings + a.contactClicks),
  );
  return stats;
}

export interface EmbedVenueSource {
  slug: string;
  nameAr: string;
  nameEn: string;
  currency: string;
  priceFromAmount: number | null;
  weeklyHours: unknown;
  ratingAvg: unknown;
  ratingCount: number;
  photos: { url: string }[];
  governorate: { nameAr: string; nameEn: string } | null;
}

export interface EmbedVenueCard {
  slug: string;
  name: { ar: string; en: string };
  photoUrl: string | null;
  priceFrom: { amount: number; currency: string } | null;
  hours: HoursSummary | null;
  place: { ar: string; en: string } | null;
  rating: { avg: number; count: number } | null;
}

/** The few facts the partner widget shows; nothing private and no reviews or courts. */
export function toEmbedCard(
  venue: EmbedVenueSource,
  area: { nameAr: string; nameEn: string } | null,
): EmbedVenueCard {
  const place = area ?? venue.governorate;
  const avg = Number(venue.ratingAvg ?? 0);
  return {
    slug: venue.slug,
    name: { ar: venue.nameAr, en: venue.nameEn },
    photoUrl: venue.photos[0]?.url ?? null,
    priceFrom:
      venue.priceFromAmount && venue.priceFromAmount > 0
        ? { amount: venue.priceFromAmount, currency: venue.currency }
        : null,
    hours: summarizeHours(venue.weeklyHours),
    place: place ? { ar: place.nameAr, en: place.nameEn } : null,
    rating:
      venue.ratingCount > 0 && avg > 0
        ? { avg: Math.round(avg * 10) / 10, count: venue.ratingCount }
        : null,
  };
}
