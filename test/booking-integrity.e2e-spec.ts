import { PrismaClient } from '@prisma/client';

describe('booking database integrity (e2e)', () => {
  const prisma = new PrismaClient();

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('prevents both court overlap and one player booking two places at once', async () => {
    await prisma.countryConfig.upsert({
      where: { code: 'EG' },
      update: {},
      create: {
        code: 'EG', nameEn: 'Egypt', nameAr: 'مصر', currency: 'EGP',
        phoneCallingCode: '+20', timezone: 'Africa/Cairo', locale: 'ar',
        paymentMethods: ['cash'],
      },
    });
    const sport = await prisma.sportCategory.create({
      data: { slug: 'qa-football', nameEn: 'Football', nameAr: 'كرة قدم', icon: 'football' },
    });
    const owner = await prisma.user.create({
      data: { name: 'QA Owner', email: 'booking-owner@matchena.test', roles: ['owner'], countryCode: 'EG' },
    });
    const player = await prisma.user.create({
      data: { name: 'QA Player', email: 'booking-player@matchena.test', roles: ['player'], countryCode: 'EG' },
    });
    const otherPlayer = await prisma.user.create({
      data: { name: 'Other Player', email: 'booking-other@matchena.test', roles: ['player'], countryCode: 'EG' },
    });
    const venue = await prisma.venue.create({
      data: {
        slug: 'qa-booking-venue', ownerId: owner.id, countryCode: 'EG',
        nameEn: 'QA Venue', nameAr: 'ملعب اختبار', lat: 30, lng: 31,
        geohash: 'stq4', status: 'active', instantBook: true,
      },
    });
    const [courtOne, courtTwo] = await Promise.all([
      prisma.court.create({ data: { venueId: venue.id, sportId: sport.id, name: 'Court 1' } }),
      prisma.court.create({ data: { venueId: venue.id, sportId: sport.id, name: 'Court 2' } }),
    ]);
    const slotStart = new Date('2027-01-10T18:00:00.000Z');
    const slotEnd = new Date('2027-01-10T19:00:00.000Z');
    const booking = (courtId: string, userId: string, code: string) => ({
      courtId, venueId: venue.id, userId, code, slotStart, slotEnd,
      baseAmount: 10000, totalAmount: 10000, currency: 'EGP', status: 'confirmed' as const,
    });

    await prisma.booking.create({ data: booking(courtOne.id, player.id, 'QA-ONE') });

    await expect(
      prisma.booking.create({ data: booking(courtTwo.id, player.id, 'QA-USER-OVERLAP') }),
    ).rejects.toThrow(/Booking_user_slot_range_excl|23P01/);

    await expect(
      prisma.booking.create({ data: booking(courtOne.id, otherPlayer.id, 'QA-COURT-OVERLAP') }),
    ).rejects.toThrow(/Booking_court_slot_range_excl|23P01/);

    await expect(
      prisma.booking.create({
        data: {
          ...booking(courtTwo.id, otherPlayer.id, 'QA-NON-OVERLAP'),
          slotStart: slotEnd,
          slotEnd: new Date('2027-01-10T20:00:00.000Z'),
        },
      }),
    ).resolves.toMatchObject({ code: 'QA-NON-OVERLAP' });

    // Manual bookings are stored under the owner who recorded them, so the
    // one-player rule must not stop two walk-ins at the same hour on different
    // courts, or a walk-in that overlaps the owner's own player booking.
    const ownerVenue = await prisma.venue.create({
      data: {
        slug: 'qa-booking-owner-venue', ownerId: owner.id, countryCode: 'EG',
        nameEn: 'QA Owner Venue', nameAr: 'ملعب المالك', lat: 30, lng: 31,
        geohash: 'stq4', status: 'active', instantBook: true,
      },
    });
    const [ownerCourtOne, ownerCourtTwo] = await Promise.all([
      prisma.court.create({ data: { venueId: ownerVenue.id, sportId: sport.id, name: 'Court 1' } }),
      prisma.court.create({ data: { venueId: ownerVenue.id, sportId: sport.id, name: 'Court 2' } }),
    ]);
    await prisma.booking.create({ data: booking(courtTwo.id, owner.id, 'QA-OWNER-PLAYS') });
    const walkIn = (courtId: string, code: string) => ({
      ...booking(courtId, owner.id, code), venueId: ownerVenue.id, source: 'manual' as const,
    });
    await expect(
      prisma.booking.create({ data: walkIn(ownerCourtOne.id, 'QA-WALKIN-ONE') }),
    ).resolves.toMatchObject({ code: 'QA-WALKIN-ONE' });
    await expect(
      prisma.booking.create({ data: walkIn(ownerCourtTwo.id, 'QA-WALKIN-TWO') }),
    ).resolves.toMatchObject({ code: 'QA-WALKIN-TWO' });
    await expect(
      prisma.booking.create({ data: walkIn(ownerCourtOne.id, 'QA-WALKIN-COURT-OVERLAP') }),
    ).rejects.toThrow(/Booking_court_slot_range_excl|23P01|Unique constraint/);
  });
});
