import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AreaCatalogService, type AreaCatalog } from '../geo/area-catalog.service';
import type { CatalogDistrict } from '../geo/area-catalog.util';
import {
  COUNTRY_SLUGS,
  countryCodeForSlug,
  indexDecision,
  landingStats,
  nearestPlaces,
  summarizeHours,
  type HoursSummary,
  type IndexReason,
  type LandingKind,
  type LandingStats,
} from './local-landing.util';

const SNAPSHOT_TTL_MS = 2 * 60_000;
const PAGE_SIZE = 24;

export interface Named {
  slug: string;
  nameAr: string;
  nameEn: string;
}

export interface SnapshotVenue {
  id: string;
  slug: string;
  nameAr: string;
  nameEn: string;
  summaryAr: string;
  summaryEn: string;
  address: string | null;
  lat: number;
  lng: number;
  governorateId: string | null;
  areaId: string | null;
  ratingAvg: number;
  ratingCount: number;
  instantBook: boolean;
  featured: boolean;
  priceFromAmount: number | null;
  currency: string;
  updatedAt: Date;
  photo: string | null;
  photoCount: number;
  courtCount: number;
  sportSlugs: string[];
  /** Cheapest hourly base price per sport, minor units. */
  sportPrice: Record<string, number>;
  amenities: string[];
  hours: HoursSummary | null;
}

export interface SportRow extends Named {
  id: string;
  icon: string;
  activityKind: string | null;
}

interface Snapshot {
  countryCode: string;
  country: { code: string; slug: string; nameAr: string; nameEn: string; currency: string };
  venues: SnapshotVenue[];
  sports: SportRow[];
  catalog: AreaCatalog;
}

export interface LandingPlaceLink extends Named {
  path: string;
  venueCount: number;
  indexable: boolean;
  distanceKm?: number;
  sportCount?: number;
}

const snippet = (value: string | null | undefined, max = 220): string => {
  const text = (value ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 40)).trim()}…`;
};

/**
 * Local landing pages are generated from live inventory. Everything is computed from one
 * cached snapshot of public venues, so a busy landing page costs no database work.
 */
@Injectable()
export class LocalLandingService {
  private snapshots = new Map<string, { until: number; value: Promise<Snapshot> }>();
  private reviewCache = new Map<string, { until: number; value: Promise<unknown[]> }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly areas: AreaCatalogService,
  ) {}

  // ───────────────────────────── snapshot ─────────────────────────────

  private snapshot(countryCode: string): Promise<Snapshot> {
    const hit = this.snapshots.get(countryCode);
    if (hit && hit.until > Date.now()) return hit.value;
    const value = this.loadSnapshot(countryCode);
    this.snapshots.set(countryCode, { until: Date.now() + SNAPSHOT_TTL_MS, value });
    value.catch(() => this.snapshots.delete(countryCode));
    return value;
  }

  private async loadSnapshot(countryCode: string): Promise<Snapshot> {
    const [country, rows, sports, catalog] = await Promise.all([
      this.prisma.countryConfig.findUnique({
        where: { code: countryCode },
        select: { code: true, nameAr: true, nameEn: true, currency: true },
      }),
      this.prisma.venue.findMany({
        where: {
          countryCode,
          status: 'active',
          isDemo: false,
          // Same rule as public search: a venue without opening hours is not listed.
          NOT: { weeklyHours: { equals: Prisma.DbNull } },
        },
        select: {
          id: true,
          slug: true,
          nameAr: true,
          nameEn: true,
          descriptionAr: true,
          descriptionEn: true,
          address: true,
          lat: true,
          lng: true,
          governorateId: true,
          districtId: true,
          ratingAvg: true,
          ratingCount: true,
          instantBook: true,
          featured: true,
          priceFromAmount: true,
          currency: true,
          updatedAt: true,
          weeklyHours: true,
          photos: { orderBy: { position: 'asc' }, take: 1, select: { url: true } },
          _count: { select: { photos: true } },
          sports: { select: { sport: { select: { slug: true } } } },
          amenities: { select: { amenity: { select: { key: true } } } },
          courts: {
            select: {
              slotDurationMins: true,
              gamingHourlyRateMinor: true,
              sport: { select: { slug: true } },
              pricingRules: { where: { kind: 'base' }, select: { priceAmount: true } },
            },
          },
        },
      }),
      this.prisma.sportCategory.findMany({
        select: { id: true, slug: true, nameAr: true, nameEn: true, icon: true, activityKind: true },
      }),
      this.areas.get(),
    ]);
    if (!country) throw new NotFoundException('Country not found');
    const venues = rows.map((v): SnapshotVenue => {
      const sportPrice: Record<string, number> = {};
      for (const court of v.courts) {
        const perHour = [
          ...court.pricingRules.map((r) => Math.round((r.priceAmount * 60) / Math.max(court.slotDurationMins || 60, 15))),
          ...(court.gamingHourlyRateMinor ? [court.gamingHourlyRateMinor] : []),
        ].filter((p) => p > 0);
        if (!perHour.length) continue;
        const min = Math.min(...perHour);
        const slug = court.sport.slug;
        if (sportPrice[slug] == null || min < sportPrice[slug]) sportPrice[slug] = min;
      }
      return {
        id: v.id,
        slug: v.slug,
        nameAr: v.nameAr,
        nameEn: v.nameEn,
        summaryAr: snippet(v.descriptionAr),
        summaryEn: snippet(v.descriptionEn),
        address: v.address,
        lat: v.lat,
        lng: v.lng,
        governorateId: v.governorateId,
        areaId: v.districtId ? catalog.areaOf.get(v.districtId) ?? null : null,
        ratingAvg: v.ratingAvg,
        ratingCount: v.ratingCount,
        instantBook: v.instantBook,
        featured: v.featured,
        priceFromAmount: v.priceFromAmount,
        currency: v.currency,
        updatedAt: v.updatedAt,
        photo: v.photos[0]?.url ?? null,
        photoCount: v._count.photos,
        courtCount: v.courts.length,
        sportSlugs: [...new Set(v.sports.map((s) => s.sport.slug))],
        sportPrice,
        amenities: v.amenities.map((a) => a.amenity.key),
        hours: summarizeHours(v.weeklyHours),
      };
    });
    return {
      countryCode,
      country: { ...country, slug: COUNTRY_SLUGS[countryCode] },
      venues,
      sports,
      catalog,
    };
  }

  // ───────────────────────────── helpers ─────────────────────────────

  private governoratesOf(s: Snapshot) {
    return s.catalog.governorates.filter((g) => g.countryCode === s.countryCode && g.slug);
  }

  private areasOf(s: Snapshot, governorateId: string) {
    return s.catalog.areas.filter((a) => a.governorateId === governorateId && a.slug);
  }

  private facts(venues: SnapshotVenue[], sport?: string) {
    return venues.map((v) => ({
      id: v.id,
      priceFromAmount: sport ? v.sportPrice[sport] ?? v.priceFromAmount : v.priceFromAmount,
      ratingAvg: v.ratingAvg,
      ratingCount: v.ratingCount,
      instantBook: v.instantBook,
      hasPhoto: !!v.photo,
      sportSlugs: v.sportSlugs,
      hours: v.hours,
    }));
  }

  private sportCounts(venues: SnapshotVenue[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const v of venues) for (const slug of v.sportSlugs) counts[slug] = (counts[slug] ?? 0) + 1;
    return counts;
  }

  private centroid(points: { lat: number | null; lng: number | null }[]): { lat: number; lng: number } | null {
    const located = points.filter((p) => p.lat != null && p.lng != null);
    if (!located.length) return null;
    return {
      lat: located.reduce((n, p) => n + p.lat!, 0) / located.length,
      lng: located.reduce((n, p) => n + p.lng!, 0) / located.length,
    };
  }

  private paths(s: Snapshot) {
    const base = `/${s.country.slug}`;
    return {
      country: base,
      governorate: (gov: Named) => `${base}/${gov.slug}`,
      area: (gov: Named, area: Named) => `${base}/${gov.slug}/${area.slug}`,
      sport: (prefix: string, sport: Named) => `${prefix}/${sport.slug}`,
    };
  }

  private rank(a: SnapshotVenue, b: SnapshotVenue): number {
    return (
      Number(b.featured) - Number(a.featured) ||
      Number(!!b.photo) - Number(!!a.photo) ||
      b.ratingAvg * Math.min(b.ratingCount, 20) - a.ratingAvg * Math.min(a.ratingCount, 20) ||
      b.photoCount - a.photoCount ||
      (a.priceFromAmount ?? Infinity) - (b.priceFromAmount ?? Infinity) ||
      a.slug.localeCompare(b.slug)
    );
  }

  private amenityCounts(venues: SnapshotVenue[]) {
    const counts = new Map<string, number>();
    for (const v of venues) for (const key of v.amenities) counts.set(key, (counts.get(key) ?? 0) + 1);
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([key, venueCount]) => ({ key, venueCount }));
  }

  private latest(venues: SnapshotVenue[]): string | null {
    const time = Math.max(0, ...venues.map((v) => v.updatedAt.getTime()));
    return time ? new Date(time).toISOString() : null;
  }

  // ───────────────────────────── directory ─────────────────────────────

  /** Every governorate and named area with live counts: drives the footer, home, explore filter and HTML sitemap. */
  async directory(countryCode = 'EG') {
    const s = await this.snapshot(countryCode);
    const p = this.paths(s);
    const sportCounts = this.sportCounts(s.venues);
    const governorates = this.governoratesOf(s).map((gov) => {
      const govVenues = s.venues.filter((v) => v.governorateId === gov.id);
      const govSports = this.sportCounts(govVenues);
      // Every named area is listed (the explore filter needs them), but fields are only sent
      // when they say something: this payload is inlined into every server-rendered page.
      const round = (n: number | null) => (n == null ? null : Math.round(n * 10_000) / 10_000);
      const areas = this.areasOf(s, gov.id).map((area) => {
        const areaVenues = govVenues.filter((v) => v.areaId === area.id);
        const base = { id: area.id, slug: area.slug!, nameAr: area.nameAr, nameEn: area.nameEn, lat: round(area.lat), lng: round(area.lng) };
        if (!areaVenues.length) return base;
        return {
          ...base,
          venueCount: areaVenues.length,
          indexable: indexDecision({ kind: 'area', venues: this.facts(areaVenues) }).indexable,
          sports: this.sportCounts(areaVenues),
        };
      });
      const center = this.centroid(this.areasOf(s, gov.id));
      return {
        id: gov.id,
        slug: gov.slug!,
        nameAr: gov.nameAr,
        nameEn: gov.nameEn,
        lat: center ? Math.round(center.lat * 10_000) / 10_000 : null,
        lng: center ? Math.round(center.lng * 10_000) / 10_000 : null,
        path: p.governorate(gov as Named),
        venueCount: govVenues.length,
        indexable: indexDecision({ kind: 'governorate', venues: this.facts(govVenues) }).indexable,
        sports: govSports,
        areas,
      };
    });
    return {
      country: s.country,
      path: p.country,
      updatedAt: this.latest(s.venues),
      venueCount: s.venues.length,
      sports: s.sports
        .map((sport) => ({
          slug: sport.slug,
          nameAr: sport.nameAr,
          nameEn: sport.nameEn,
          icon: sport.icon,
          activityKind: sport.activityKind,
          venueCount: sportCounts[sport.slug] ?? 0,
        }))
        .sort((a, b) => b.venueCount - a.venueCount || a.nameEn.localeCompare(b.nameEn)),
      governorates: governorates.sort((a, b) => b.venueCount - a.venueCount || a.nameEn.localeCompare(b.nameEn)),
    };
  }

  // ───────────────────────────── landing ─────────────────────────────

  /** Resolves `/egypt[/gov[/area|sport[/sport]]]` and builds the page from live inventory. */
  async landing(countrySlug: string, rawSegments: string[], page = 1) {
    const countryCode = countryCodeForSlug(countrySlug);
    if (!countryCode) throw new NotFoundException('Unknown country');
    const segments = rawSegments.map((x) => x.trim().toLowerCase()).filter(Boolean);
    if (segments.length > 3) throw new NotFoundException('Unknown place');
    const s = await this.snapshot(countryCode);
    const p = this.paths(s);
    const sportBySlug = new Map(s.sports.map((x) => [x.slug, x]));

    const [govSlug, second, third] = segments;
    const gov = govSlug ? this.governoratesOf(s).find((g) => g.slug === govSlug) : undefined;
    if (govSlug && !gov) throw new NotFoundException('Unknown governorate');
    let area: CatalogDistrict | undefined;
    let sport: SportRow | undefined;
    if (gov && second) {
      area = this.areasOf(s, gov.id).find((a) => a.slug === second);
      if (!area) sport = sportBySlug.get(second);
      if (!area && !sport) throw new NotFoundException('Unknown place');
      if (third) {
        if (!area) throw new NotFoundException('Unknown place');
        sport = sportBySlug.get(third);
        if (!sport) throw new NotFoundException('Unknown sport');
      }
    }
    const kind: LandingKind = !gov
      ? 'country'
      : area
        ? sport ? 'area-sport' : 'area'
        : sport ? 'governorate-sport' : 'governorate';

    const govNamed = gov as Named | undefined;
    const areaNamed = area as Named | undefined;
    const placePath = !gov ? p.country : area ? p.area(govNamed!, areaNamed!) : p.governorate(govNamed!);
    const path = sport ? p.sport(placePath, sport) : placePath;

    const placeVenues = s.venues.filter(
      (v) => (!gov || v.governorateId === gov.id) && (!area || v.areaId === area.id),
    );
    const venues = sport ? placeVenues.filter((v) => v.sportSlugs.includes(sport.slug)) : placeVenues;
    const placeSports = this.sportCounts(placeVenues);
    const facts = this.facts(venues, sport?.slug);
    const decision = indexDecision({
      kind,
      venues: facts,
      parentCount: placeVenues.length,
      parentSportCount: Object.keys(placeSports).length,
    });

    const breadcrumbs: (Named & { path: string })[] = [
      { slug: s.country.slug, nameAr: s.country.nameAr, nameEn: s.country.nameEn, path: p.country },
    ];
    if (gov) breadcrumbs.push({ ...(govNamed!), path: p.governorate(govNamed!) });
    if (area) breadcrumbs.push({ ...(areaNamed!), path: p.area(govNamed!, areaNamed!) });
    if (sport) breadcrumbs.push({ slug: sport.slug, nameAr: sport.nameAr, nameEn: sport.nameEn, path });

    // Sports offered in this place, each linking to its narrower page.
    const sports = s.sports
      .filter((x) => placeSports[x.slug])
      .map((x) => {
        const sportVenues = placeVenues.filter((v) => v.sportSlugs.includes(x.slug));
        const sportStats = landingStats(this.facts(sportVenues, x.slug));
        const sportKind: LandingKind = kind === 'country' ? 'governorate-sport' : area ? 'area-sport' : 'governorate-sport';
        return {
          slug: x.slug,
          nameAr: x.nameAr,
          nameEn: x.nameEn,
          icon: x.icon,
          activityKind: x.activityKind,
          venueCount: sportVenues.length,
          priceMin: sportStats.priceMin,
          priceMax: sportStats.priceMax,
          // The country level has no "/egypt/football": its sport hub is /sports/:slug.
          path: kind === 'country' ? `/sports/${x.slug}` : p.sport(placePath, x),
          indexable:
            kind === 'country'
              ? sportVenues.length > 0
              : indexDecision({
                  kind: sportKind,
                  venues: this.facts(sportVenues, x.slug),
                  parentCount: placeVenues.length,
                  parentSportCount: Object.keys(placeSports).length,
                }).indexable,
        };
      })
      .sort((a, b) => b.venueCount - a.venueCount);

    const children = this.childrenOf(s, kind, gov?.id, sport?.slug);
    const nearby = this.nearbyOf(s, kind, gov?.id, area, sport?.slug);

    const totalPages = Math.max(1, Math.ceil(venues.length / PAGE_SIZE));
    const current = Math.min(Math.max(1, Math.floor(page) || 1), totalPages);
    const ordered = [...venues].sort((a, b) => this.rank(a, b));
    const items = ordered.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE).map((v) => this.card(s, v, sport?.slug));

    const center = area?.lat != null && area?.lng != null
      ? { lat: area.lat, lng: area.lng }
      : this.centroid(venues.length ? venues : gov ? this.areasOf(s, gov.id) : []);

    return {
      kind,
      path,
      // A sport page identical to its parent points search engines at the parent.
      canonicalPath: decision.reason === 'same-as-parent' ? placePath : path,
      indexable: decision.indexable,
      indexReason: decision.reason as IndexReason,
      country: s.country,
      governorate: gov ? { slug: gov.slug!, nameAr: gov.nameAr, nameEn: gov.nameEn, path: p.governorate(govNamed!) } : null,
      area: area ? { slug: area.slug!, nameAr: area.nameAr, nameEn: area.nameEn, path: p.area(govNamed!, areaNamed!) } : null,
      sport: sport ? { slug: sport.slug, nameAr: sport.nameAr, nameEn: sport.nameEn, icon: sport.icon, activityKind: sport.activityKind } : null,
      parentPath: sport ? placePath : breadcrumbs.length > 1 ? breadcrumbs[breadcrumbs.length - 2].path : null,
      breadcrumbs,
      updatedAt: this.latest(venues),
      center,
      stats: { ...landingStats(facts), currency: s.country.currency } as LandingStats & { currency: string },
      amenities: this.amenityCounts(venues),
      sports,
      children,
      nearby,
      venues: { items, page: current, pageSize: PAGE_SIZE, total: venues.length, totalPages },
      reviews: await this.reviewsFor(path, ordered.map((v) => v.id)),
    };
  }

  private card(s: Snapshot, v: SnapshotVenue, sport?: string) {
    const area = v.areaId ? s.catalog.areaById.get(v.areaId) : undefined;
    const gov = v.governorateId ? s.catalog.governorateById.get(v.governorateId) : undefined;
    return {
      id: v.id,
      slug: v.slug,
      nameAr: v.nameAr,
      nameEn: v.nameEn,
      summaryAr: v.summaryAr,
      summaryEn: v.summaryEn,
      address: v.address,
      lat: v.lat,
      lng: v.lng,
      photo: v.photo,
      photoCount: v.photoCount,
      courtCount: v.courtCount,
      ratingAvg: v.ratingAvg,
      ratingCount: v.ratingCount,
      instantBook: v.instantBook,
      priceFrom: {
        amount: (sport ? v.sportPrice[sport] : undefined) ?? v.priceFromAmount ?? 0,
        currency: v.currency,
      },
      sportSlugs: v.sportSlugs,
      amenities: v.amenities,
      hours: v.hours ? { openDays: v.hours.openDays, open: v.hours.earliestOpen, close: v.hours.latestClose, lateNight: v.hours.lateNight } : null,
      area: area ? { slug: area.slug, nameAr: area.nameAr, nameEn: area.nameEn } : null,
      governorate: gov ? { slug: gov.slug, nameAr: gov.nameAr, nameEn: gov.nameEn } : null,
      updatedAt: v.updatedAt.toISOString(),
    };
  }

  /** Narrower places with inventory: governorates of the country, areas of a governorate. */
  private childrenOf(s: Snapshot, kind: LandingKind, govId?: string, sport?: string): LandingPlaceLink[] {
    const p = this.paths(s);
    const match = (v: SnapshotVenue) => !sport || v.sportSlugs.includes(sport);
    if (kind === 'country') {
      return this.governoratesOf(s)
        .map((gov) => {
          const list = s.venues.filter((v) => v.governorateId === gov.id);
          return {
            slug: gov.slug!,
            nameAr: gov.nameAr,
            nameEn: gov.nameEn,
            path: p.governorate(gov as Named),
            venueCount: list.length,
            indexable: indexDecision({ kind: 'governorate', venues: this.facts(list) }).indexable,
          };
        })
        .filter((x) => x.venueCount > 0)
        .sort((a, b) => b.venueCount - a.venueCount);
    }
    if ((kind === 'governorate' || kind === 'governorate-sport') && govId) {
      const gov = s.catalog.governorateById.get(govId)! as Named;
      return this.areasOf(s, govId)
        .map((area) => {
          const list = s.venues.filter((v) => v.areaId === area.id && match(v));
          const areaPath = p.area(gov, area as Named);
          return {
            slug: area.slug!,
            nameAr: area.nameAr,
            nameEn: area.nameEn,
            path: sport ? `${areaPath}/${sport}` : areaPath,
            venueCount: list.length,
            indexable: indexDecision({ kind: sport ? 'area-sport' : 'area', venues: this.facts(list, sport) }).indexable,
          };
        })
        .filter((x) => x.venueCount > 0)
        .sort((a, b) => b.venueCount - a.venueCount || a.nameEn.localeCompare(b.nameEn));
    }
    return [];
  }

  /** Neighbouring places (by centre distance) that have venues, same sport first when on a sport page. */
  private nearbyOf(s: Snapshot, kind: LandingKind, govId?: string, area?: CatalogDistrict, sport?: string): LandingPlaceLink[] {
    const p = this.paths(s);
    const match = (v: SnapshotVenue) => !sport || v.sportSlugs.includes(sport);
    if (area) {
      const candidates = s.catalog.areas
        .filter((a) => a.slug && s.catalog.governorateById.get(a.governorateId)?.countryCode === s.countryCode)
        .map((a) => {
          const list = s.venues.filter((v) => v.areaId === a.id);
          return { ...a, venueCount: list.length, sportCount: list.filter(match).length };
        })
        .filter((a) => a.venueCount > 0);
      return nearestPlaces(area, candidates).map((a) => {
        const gov = s.catalog.governorateById.get(a.governorateId)! as Named;
        const areaPath = p.area(gov, a as Named);
        const useSport = !!sport && a.sportCount > 0;
        return {
          slug: a.slug!,
          nameAr: a.nameAr,
          nameEn: a.nameEn,
          path: useSport ? `${areaPath}/${sport}` : areaPath,
          venueCount: useSport ? a.sportCount : a.venueCount,
          sportCount: a.sportCount,
          distanceKm: a.distanceKm,
          indexable: indexDecision({
            kind: useSport ? 'area-sport' : 'area',
            venues: this.facts(s.venues.filter((v) => v.areaId === a.id && (!useSport || match(v)))),
          }).indexable,
        };
      });
    }
    if (govId && kind !== 'country') {
      const origin = { id: govId, ...(this.centroid(this.areasOf(s, govId)) ?? { lat: null, lng: null }) };
      const govs = this.governoratesOf(s)
        .map((g) => {
          const list = s.venues.filter((v) => v.governorateId === g.id);
          return { ...g, ...(this.centroid(this.areasOf(s, g.id)) ?? { lat: null, lng: null }), venueCount: list.length, sportCount: list.filter(match).length };
        })
        .filter((g) => g.venueCount > 0);
      return nearestPlaces(origin, govs, 6).map((g) => ({
        slug: g.slug!,
        nameAr: g.nameAr,
        nameEn: g.nameEn,
        path: sport && g.sportCount ? `${p.governorate(g as Named)}/${sport}` : p.governorate(g as Named),
        venueCount: sport && g.sportCount ? g.sportCount : g.venueCount,
        sportCount: g.sportCount,
        distanceKm: g.distanceKm,
        indexable: indexDecision({ kind: 'governorate', venues: this.facts(s.venues.filter((v) => v.governorateId === g.id)) }).indexable,
      }));
    }
    return [];
  }

  /** Latest written reviews for the venues on a page (text only; first name for privacy). */
  private reviewsFor(key: string, venueIds: string[]) {
    const hit = this.reviewCache.get(key);
    if (hit && hit.until > Date.now()) return hit.value;
    const value = venueIds.length
      ? this.prisma.venueReview
          .findMany({
            where: { venueId: { in: venueIds.slice(0, 200) }, text: { not: null } },
            orderBy: { createdAt: 'desc' },
            take: 6,
            select: {
              stars: true,
              text: true,
              createdAt: true,
              user: { select: { name: true } },
              venue: { select: { slug: true, nameAr: true, nameEn: true } },
            },
          })
          .then((rows) =>
            rows
              .filter((r) => (r.text ?? '').trim().length >= 8)
              .map((r) => ({
                stars: r.stars,
                text: snippet(r.text, 280),
                author: (r.user?.name ?? '').trim().split(/\s+/)[0] || null,
                createdAt: r.createdAt.toISOString(),
                venue: r.venue,
              })),
          )
      : Promise.resolve([]);
    this.reviewCache.set(key, { until: Date.now() + SNAPSHOT_TTL_MS, value });
    if (this.reviewCache.size > 500) this.reviewCache.delete(this.reviewCache.keys().next().value!);
    value.catch(() => this.reviewCache.delete(key));
    return value;
  }

  // ───────────────────────────── sitemap ─────────────────────────────

  /** Indexable landing pages only, with the freshest venue change and a few real photos each. */
  async sitemapEntries(): Promise<{ path: string; lastmod: Date | null; images: string[] }[]> {
    const entries: { path: string; lastmod: Date | null; images: string[] }[] = [];
    for (const countryCode of Object.keys(COUNTRY_SLUGS)) {
      const s = await this.snapshot(countryCode).catch(() => null);
      if (!s) continue;
      const p = this.paths(s);
      const add = (path: string, list: SnapshotVenue[], kind: LandingKind, parent?: SnapshotVenue[]) => {
        const sportCount = parent ? Object.keys(this.sportCounts(parent)).length : undefined;
        if (!indexDecision({ kind, venues: this.facts(list), parentCount: parent?.length, parentSportCount: sportCount }).indexable) return;
        const time = Math.max(0, ...list.map((v) => v.updatedAt.getTime()));
        entries.push({
          path,
          lastmod: time ? new Date(time) : null,
          images: [...list].sort((a, b) => this.rank(a, b)).map((v) => v.photo).filter((x): x is string => !!x).slice(0, 5),
        });
      };
      add(p.country, s.venues, 'country');
      for (const gov of this.governoratesOf(s)) {
        const govVenues = s.venues.filter((v) => v.governorateId === gov.id);
        if (!govVenues.length) continue;
        const govPath = p.governorate(gov as Named);
        add(govPath, govVenues, 'governorate');
        for (const slug of Object.keys(this.sportCounts(govVenues))) {
          add(`${govPath}/${slug}`, govVenues.filter((v) => v.sportSlugs.includes(slug)), 'governorate-sport', govVenues);
        }
        for (const area of this.areasOf(s, gov.id)) {
          const areaVenues = govVenues.filter((v) => v.areaId === area.id);
          if (!areaVenues.length) continue;
          const areaPath = p.area(gov as Named, area as Named);
          add(areaPath, areaVenues, 'area');
          for (const slug of Object.keys(this.sportCounts(areaVenues))) {
            add(`${areaPath}/${slug}`, areaVenues.filter((v) => v.sportSlugs.includes(slug)), 'area-sport', areaVenues);
          }
        }
      }
    }
    return entries;
  }

  /** Landing path for a venue's place, used to repair legacy `/explore?district=` links. */
  async pathForPlace(countryCode: string, params: { governorate?: string; district?: string; sport?: string }): Promise<string | null> {
    const slug = COUNTRY_SLUGS[countryCode];
    if (!slug) return null;
    const s = await this.snapshot(countryCode);
    const p = this.paths(s);
    const sport = params.sport ? s.sports.find((x) => x.slug === params.sport) : undefined;
    if (params.sport && !sport) return null;
    if (params.district) {
      const district = await this.prisma.district.findFirst({
        where: { OR: [{ slug: params.district }, { id: params.district }], governorate: { countryCode } },
        select: { id: true, governorateId: true },
      });
      if (!district) return null;
      const areaId = s.catalog.areaOf.get(district.id);
      const area = areaId ? s.catalog.areaById.get(areaId) : undefined;
      // A census sub-area outside every named area still belongs to a governorate page.
      const gov = s.catalog.governorateById.get(area?.governorateId ?? district.governorateId);
      if (!gov?.slug) return null;
      const base = area ? p.area(gov as Named, area as Named) : p.governorate(gov as Named);
      return sport ? `${base}/${sport.slug}` : base;
    }
    if (params.governorate) {
      const gov = this.governoratesOf(s).find((g) => g.slug === params.governorate || g.id === params.governorate);
      if (!gov) return null;
      const base = p.governorate(gov as Named);
      return sport ? `${base}/${sport.slug}` : base;
    }
    return null;
  }
}
