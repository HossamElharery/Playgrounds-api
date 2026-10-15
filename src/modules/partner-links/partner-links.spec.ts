import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { PartnerLinksService } from './partner-links.service';
import { PartnerVisitDto } from './partner-links.dto';
import {
  foldPartnerStats,
  toEmbedCard,
  type EmbedVenueSource,
} from './partner-links.util';

const source = (extra: Partial<EmbedVenueSource> = {}): EmbedVenueSource => ({
  slug: 'arena',
  nameAr: 'الساحة',
  nameEn: 'Arena',
  currency: 'EGP',
  priceFromAmount: 40000,
  weeklyHours: { 0: { open: '16:00', close: '02:00' } },
  ratingAvg: 4.26,
  ratingCount: 3,
  photos: [{ url: '/uploads/a.jpg' }],
  governorate: { nameAr: 'القاهرة', nameEn: 'Cairo' },
  ...extra,
});

describe('partner links: embed card', () => {
  it('keeps only the public facts the widget shows', () => {
    const card = toEmbedCard(source(), {
      nameAr: 'مدينة نصر',
      nameEn: 'Nasr City',
    });
    expect(card).toEqual({
      slug: 'arena',
      name: { ar: 'الساحة', en: 'Arena' },
      photoUrl: '/uploads/a.jpg',
      priceFrom: { amount: 40000, currency: 'EGP' },
      hours: expect.objectContaining({
        earliestOpen: '16:00',
        latestClose: '02:00',
        lateNight: true,
      }),
      place: { ar: 'مدينة نصر', en: 'Nasr City' },
      rating: { avg: 4.3, count: 3 },
    });
  });

  it('falls back to the governorate and hides empty price, photo and rating', () => {
    const card = toEmbedCard(
      source({
        priceFromAmount: 0,
        photos: [],
        ratingCount: 0,
        weeklyHours: null,
      }),
      null,
    );
    expect(card.place).toEqual({ ar: 'القاهرة', en: 'Cairo' });
    expect(card.priceFrom).toBeNull();
    expect(card.photoUrl).toBeNull();
    expect(card.rating).toBeNull();
    expect(card.hours).toBeNull();
  });
});

describe('partner links: stats', () => {
  it('folds grouped rows into totals and a per-medium list', () => {
    const stats = foldPartnerStats([
      { name: 'partner.landing', medium: 'badge', total: 7, last30: 2 },
      { name: 'partner.landing', medium: 'qr', total: 3, last30: 3 },
      { name: 'partner.contact_click', medium: 'badge', total: 2, last30: 1 },
      { name: 'partner.landing', medium: null, total: 1, last30: 0 },
      { name: 'something.else', medium: 'badge', total: 99, last30: 99 },
    ]);
    expect(stats.total).toEqual({ landings: 11, contactClicks: 2 });
    expect(stats.last30).toEqual({ landings: 5, contactClicks: 1 });
    expect(stats.byMedium).toEqual([
      { medium: 'badge', landings: 7, contactClicks: 2 },
      { medium: 'qr', landings: 3, contactClicks: 0 },
      { medium: 'other', landings: 1, contactClicks: 0 },
    ]);
  });
});

describe('PartnerLinksService', () => {
  const build = (venue: unknown) => {
    const prisma = {
      venue: { findUnique: jest.fn().mockResolvedValue(venue) },
      analyticsEvent: { create: jest.fn().mockResolvedValue({}) },
      $queryRaw: jest
        .fn()
        .mockResolvedValue([
          { name: 'partner.landing', medium: 'qr', total: 4, last30: 4 },
        ]),
    };
    const areas = { areaFor: jest.fn().mockResolvedValue(null) };
    return {
      prisma,
      service: new PartnerLinksService(prisma as never, areas as never),
    };
  };

  it('logs a visit for an active venue with lower-cased UTM values', async () => {
    const { prisma, service } = build({ id: 'v1', status: 'active' });
    await service.recordVisit({
      venueSlug: 'arena',
      event: 'contact_click',
      source: 'Partner',
      medium: 'QR',
      campaign: 'arena',
    });
    expect(prisma.analyticsEvent.create).toHaveBeenCalledWith({
      data: {
        name: 'partner.contact_click',
        userId: null,
        payload: {
          venueId: 'v1',
          source: 'partner',
          medium: 'qr',
          campaign: 'arena',
        },
      },
    });
  });

  it('drops visits for unknown or inactive venues without an error', async () => {
    const { prisma, service } = build({ id: 'v1', status: 'pending' });
    await expect(
      service.recordVisit({
        venueSlug: 'arena',
        event: 'landing',
        source: 'partner',
      }),
    ).resolves.toEqual({ ok: true });
    expect(prisma.analyticsEvent.create).not.toHaveBeenCalled();
  });

  it('shows stats only to the venue owner or a privileged actor', async () => {
    const { service } = build({ ownerId: 'owner-1' });
    await expect(
      service.stats('v1', 'someone-else', false),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.stats('v1', 'owner-1', false)).resolves.toMatchObject({
      total: { landings: 4, contactClicks: 0 },
    });
    await expect(service.stats('v1', 'admin', true)).resolves.toBeDefined();
  });

  it('serves no widget for a venue that is not live', async () => {
    const { service } = build({ status: 'suspended' });
    await expect(service.embedCard('arena')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('PartnerVisitDto', () => {
  const errors = (body: object) =>
    validateSync(plainToInstance(PartnerVisitDto, body)).map((e) => e.property);

  it('accepts the values the share tools generate', () => {
    expect(
      errors({
        venueSlug: 'arena-1',
        event: 'landing',
        source: 'partner',
        medium: 'badge',
        campaign: 'arena-1',
      }),
    ).toEqual([]);
  });

  it('rejects free text, unknown events and odd slugs', () => {
    expect(
      errors({
        venueSlug: 'Arena 1',
        event: 'booking',
        source: '<script>',
      }).sort(),
    ).toEqual(['event', 'source', 'venueSlug']);
  });
});
