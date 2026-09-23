import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import * as ngeohash from 'ngeohash';
import { HELP_FAQS } from './data/help-faqs';

const prisma = new PrismaClient();

function venueSlug(country: string, nameEn: string): string {
  return `${country.toLowerCase()}-${nameEn.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`.replace(/-+$/g, '');
}

async function deleteVenueTree(venueId: string) {
  const courts = await prisma.court.findMany({
    where: { venueId },
    select: { id: true },
  });
  const courtIds = courts.map((c) => c.id);
  const bookings = await prisma.booking.findMany({
    where: { venueId },
    select: { id: true },
  });
  const bookingIds = bookings.map((b) => b.id);

  if (bookingIds.length) {
    await prisma.pulseClaim.deleteMany({
      where: { bookingId: { in: bookingIds } },
    });
    await prisma.pulseOpportunity.deleteMany({
      where: { bookingId: { in: bookingIds } },
    });
    await prisma.playerRating.deleteMany({
      where: { bookingId: { in: bookingIds } },
    });
    await prisma.promoRedemption.deleteMany({
      where: { bookingId: { in: bookingIds } },
    });
    await prisma.coinLedgerEntry.deleteMany({
      where: { bookingId: { in: bookingIds } },
    });
    await prisma.venueReview.deleteMany({
      where: { bookingId: { in: bookingIds } },
    });
    await prisma.bookingSplitShare.deleteMany({
      where: { bookingId: { in: bookingIds } },
    });
    await prisma.payment.deleteMany({
      where: { bookingId: { in: bookingIds } },
    });
    await prisma.booking.deleteMany({ where: { id: { in: bookingIds } } });
  }

  if (courtIds.length) {
    await prisma.recurringBookingSeries.deleteMany({
      where: { courtId: { in: courtIds } },
    });
    await prisma.matchPost.updateMany({
      where: { courtId: { in: courtIds } },
      data: { courtId: null },
    });
  }
  await prisma.matchPost.updateMany({
    where: { venueId },
    data: { venueId: null },
  });
  await prisma.promoCode.updateMany({
    where: { venueId },
    data: { venueId: null },
  });
    await prisma.venueLedgerEntry.deleteMany({ where: { venueId } });
    await prisma.venueSettlement.deleteMany({ where: { venueId } });
    await prisma.venueBookingSource.deleteMany({ where: { venueId } });
    await prisma.commissionSetting.deleteMany({ where: { venueId } });
  await prisma.payout.deleteMany({ where: { venueId } });
  await prisma.staffInvite.deleteMany({ where: { venueId } });
  await prisma.partnerApplication.updateMany({
    where: { venueId },
    data: { venueId: null },
  });
  await prisma.venue.delete({ where: { id: venueId } });
}

async function main() {
  console.log('Seeding Matchena reference + demo data...');

  // ---- Country / geo ----
  const egyptPaymentMethods = [
    'card',
    'wallet',
    'vodafone',
    'orange',
    'etisalat',
    'fawry',
    'instapay',
    'cash',
  ];
  await prisma.countryConfig.upsert({
    where: { code: 'EG' },
    update: {
      paymentMethods: egyptPaymentMethods,
      timezone: 'Africa/Cairo',
      locale: 'ar',
      lat: 30.0444,
      lng: 31.2357,
      active: true,
    },
    create: {
      code: 'EG',
      nameEn: 'Egypt',
      nameAr: 'مصر',
      currency: 'EGP',
      phoneCallingCode: '+20',
      timezone: 'Africa/Cairo',
      locale: 'ar',
      weekendDays: [5, 6],
      paymentMethods: egyptPaymentMethods,
      lat: 30.0444,
      lng: 31.2357,
      active: true,
    },
  });

  const gccMarkets = [
    {
      code: 'SA', nameEn: 'Saudi Arabia', nameAr: 'المملكة العربية السعودية', currency: 'SAR',
      phoneCallingCode: '+966', timezone: 'Asia/Riyadh', locale: 'ar',
      weekendDays: [5, 6], lat: 24.7136, lng: 46.6753,
      paymentMethods: ['card', 'mada', 'stc_pay', 'apple_pay', 'google_pay', 'cash'],
    },
    {
      code: 'AE', nameEn: 'United Arab Emirates', nameAr: 'الإمارات', currency: 'AED',
      phoneCallingCode: '+971', timezone: 'Asia/Dubai', locale: 'ar',
      weekendDays: [5, 6], lat: 25.2048, lng: 55.2708,
      paymentMethods: ['card', 'apple_pay', 'google_pay', 'cash'],
    },
    {
      code: 'KW', nameEn: 'Kuwait', nameAr: 'الكويت', currency: 'KWD',
      phoneCallingCode: '+965', timezone: 'Asia/Kuwait', locale: 'ar',
      weekendDays: [5, 6], lat: 29.3759, lng: 47.9774,
      paymentMethods: ['card', 'knet', 'apple_pay', 'cash'],
    },
    {
      code: 'QA', nameEn: 'Qatar', nameAr: 'قطر', currency: 'QAR',
      phoneCallingCode: '+974', timezone: 'Asia/Qatar', locale: 'ar',
      weekendDays: [5, 6], lat: 25.2854, lng: 51.531,
      paymentMethods: ['card', 'apple_pay', 'google_pay', 'cash'],
    },
    {
      code: 'JO', nameEn: 'Jordan', nameAr: 'الأردن', currency: 'JOD',
      phoneCallingCode: '+962', timezone: 'Asia/Amman', locale: 'ar',
      weekendDays: [5, 6], lat: 31.9539, lng: 35.9106,
      paymentMethods: ['card', 'wallet', 'apple_pay', 'cash'],
    },
  ];
  for (const c of gccMarkets) {
    await prisma.countryConfig.upsert({
      where: { code: c.code },
      update: {
        currency: c.currency,
        phoneCallingCode: c.phoneCallingCode,
        timezone: c.timezone,
        locale: c.locale,
        weekendDays: c.weekendDays,
        paymentMethods: c.paymentMethods,
        lat: c.lat,
        lng: c.lng,
        active: true,
      },
      create: { ...c, active: true },
    });
  }

  const cairo = await prisma.governorate.upsert({
    where: { id: 'gov-cairo' },
    update: { slug: 'cairo' },
    create: { id: 'gov-cairo', countryCode: 'EG', slug: 'cairo', nameEn: 'Cairo', nameAr: 'القاهرة' },
  });
  const giza = await prisma.governorate.upsert({
    where: { id: 'gov-giza' },
    update: { slug: 'giza' },
    create: { id: 'gov-giza', countryCode: 'EG', slug: 'giza', nameEn: 'Giza', nameAr: 'الجيزة' },
  });

  const ring = (coords: number[][]): { type: 'Polygon'; coordinates: number[][][] } => ({
    type: 'Polygon',
    coordinates: [coords],
  });
  const districts = await Promise.all(
    [
      {
        id: 'dist-nasr-city', governorateId: cairo.id, slug: 'nasr-city',
        nameEn: 'Nasr City', nameAr: 'مدينة نصر', lat: 30.0511, lng: 31.3656,
        polygon: ring([[31.34, 30.04], [31.39, 30.04], [31.39, 30.07], [31.34, 30.07], [31.34, 30.04]]),
      },
      {
        id: 'dist-maadi', governorateId: cairo.id, slug: 'maadi',
        nameEn: 'Maadi', nameAr: 'المعادي', lat: 29.9602, lng: 31.2505,
        polygon: ring([[31.22, 29.94], [31.28, 29.94], [31.28, 29.98], [31.22, 29.98], [31.22, 29.94]]),
      },
      {
        id: 'dist-new-cairo', governorateId: cairo.id, slug: 'new-cairo',
        nameEn: 'New Cairo', nameAr: 'القاهرة الجديدة', lat: 30.0074, lng: 31.4913,
        polygon: ring([[31.45, 29.98], [31.54, 29.98], [31.54, 30.04], [31.45, 30.04], [31.45, 29.98]]),
      },
      {
        id: 'dist-heliopolis', governorateId: cairo.id, slug: 'heliopolis',
        nameEn: 'Heliopolis', nameAr: 'مصر الجديدة', lat: 30.0876, lng: 31.3225,
        polygon: ring([[31.30, 30.07], [31.35, 30.07], [31.35, 30.11], [31.30, 30.11], [31.30, 30.07]]),
      },
      {
        id: 'dist-6october', governorateId: giza.id, slug: '6th-of-october',
        nameEn: '6th of October', nameAr: '6 أكتوبر', lat: 29.9729, lng: 30.9447,
        polygon: ring([[30.88, 29.94], [31.00, 29.94], [31.00, 30.02], [30.88, 30.02], [30.88, 29.94]]),
      },
      {
        id: 'dist-sheikh-zayed', governorateId: giza.id, slug: 'sheikh-zayed',
        nameEn: 'Sheikh Zayed', nameAr: 'الشيخ زايد', lat: 30.049, lng: 30.976,
        polygon: ring([[30.93, 30.02], [31.02, 30.02], [31.02, 30.08], [30.93, 30.08], [30.93, 30.02]]),
      },
    ].map((d) =>
      prisma.district.upsert({
        where: { id: d.id },
        update: { slug: d.slug, lat: d.lat, lng: d.lng, polygon: d.polygon },
        create: d,
      }),
    ),
  );

  const riyadh = await prisma.governorate.upsert({
    where: { id: 'gov-riyadh' },
    update: { slug: 'riyadh' },
    create: { id: 'gov-riyadh', countryCode: 'SA', slug: 'riyadh', nameEn: 'Riyadh', nameAr: 'الرياض' },
  });
  const dubai = await prisma.governorate.upsert({
    where: { id: 'gov-dubai' },
    update: { slug: 'dubai' },
    create: { id: 'gov-dubai', countryCode: 'AE', slug: 'dubai', nameEn: 'Dubai', nameAr: 'دبي' },
  });
  await Promise.all([
    prisma.district.upsert({
      where: { id: 'dist-olaya' },
      update: { slug: 'olaya' },
      create: {
        id: 'dist-olaya', governorateId: riyadh.id, slug: 'olaya',
        nameEn: 'Olaya', nameAr: 'العليا', lat: 24.693, lng: 46.685,
        polygon: ring([[46.67, 24.68], [46.70, 24.68], [46.70, 24.71], [46.67, 24.71], [46.67, 24.68]]),
      },
    }),
    prisma.district.upsert({
      where: { id: 'dist-marina' },
      update: { slug: 'dubai-marina' },
      create: {
        id: 'dist-marina', governorateId: dubai.id, slug: 'dubai-marina',
        nameEn: 'Dubai Marina', nameAr: 'دبي مارينا', lat: 25.0805, lng: 55.1403,
        polygon: ring([[55.13, 25.07], [55.15, 25.07], [55.15, 25.09], [55.13, 25.09], [55.13, 25.07]]),
      },
    }),
  ]);

  // ---- Sport categories ----
  const sports = await Promise.all(
    [
      { id: 'sport-football', slug: 'football', nameEn: 'Football', nameAr: 'كرة قدم', icon: 'football', accentColor: '#0E7A4E', activityKind: 'field-sport' },
      { id: 'sport-football-5', slug: 'football-5', nameEn: 'Football 5-a-side', nameAr: 'كرة قدم خماسية', icon: 'football', accentColor: '#0E7A4E', activityKind: 'field-sport' },
      { id: 'sport-padel', slug: 'padel', nameEn: 'Padel', nameAr: 'بادل', icon: 'padel', accentColor: '#3DA9FC', activityKind: 'racket-court' },
      { id: 'sport-tennis', slug: 'tennis', nameEn: 'Tennis', nameAr: 'تنس', icon: 'tennis', accentColor: '#F2B705', activityKind: 'racket-court' },
      { id: 'sport-basketball', slug: 'basketball', nameEn: 'Basketball', nameAr: 'كرة سلة', icon: 'basketball', accentColor: '#FF8A3D', activityKind: 'field-sport' },
      { id: 'sport-swimming', slug: 'swimming', nameEn: 'Swimming', nameAr: 'سباحة', icon: 'swimming', accentColor: '#2DD4BF', activityKind: 'field-sport' },
      { id: 'sport-squash', slug: 'squash', nameEn: 'Squash', nameAr: 'اسكواش', icon: 'squash', accentColor: '#8B5CF6', activityKind: 'racket-court' },
      { id: 'sport-volleyball', slug: 'volleyball', nameEn: 'Volleyball', nameAr: 'كرة طائرة', icon: 'volleyball', accentColor: '#F97316', activityKind: 'field-sport' },
      // Matchena gaming expansion — see MATCHENA_GAMING_EXPANSION_BLUEPRINT.md §3.1
      { id: 'sport-playstation', slug: 'playstation', nameEn: 'PlayStation', nameAr: 'بلايستيشن', icon: 'playstation', accentColor: '#C6FF3D', activityKind: 'gaming-station' },
      { id: 'sport-billiards', slug: 'billiards', nameEn: 'Billiards', nameAr: 'بلياردو', icon: 'billiards', accentColor: '#7C3AED', activityKind: 'table-game' },
      { id: 'sport-table-tennis', slug: 'table-tennis', nameEn: 'Table Tennis', nameAr: 'بينج بونج', icon: 'table-tennis', accentColor: '#22C7B8', activityKind: 'table-game' },
    ].map((s) => prisma.sportCategory.upsert({ where: { id: s.id }, update: { activityKind: s.activityKind }, create: s } as any)),
  );

  // ---- Amenities ----
  await Promise.all(
    [
      { key: 'parking', nameEn: 'Parking', nameAr: 'موقف سيارات', icon: 'car' },
      { key: 'showers', nameEn: 'Showers', nameAr: 'دش', icon: 'shower' },
      { key: 'lighting', nameEn: 'Floodlights', nameAr: 'إضاءة', icon: 'lightbulb' },
      { key: 'floodlights', nameEn: 'Floodlights', nameAr: 'إضاءة كاشفة', icon: 'lightbulb' },
      { key: 'cafe', nameEn: 'Cafe', nameAr: 'كافيه', icon: 'coffee' },
      { key: 'lockers', nameEn: 'Lockers', nameAr: 'خزائن', icon: 'lock' },
      { key: 'wifi', nameEn: 'Wi-Fi', nameAr: 'واي فاي', icon: 'wifi' },
      { key: 'femaleFriendly', nameEn: 'Women-friendly', nameAr: 'أوقات للنساء', icon: 'user-check' },
      { key: 'indoor', nameEn: 'Indoor', nameAr: 'مغلق', icon: 'home' },
    ].map((a) =>
      prisma.amenity.upsert({
        where: { key: a.key },
        update: { nameEn: a.nameEn, nameAr: a.nameAr, icon: a.icon },
        create: a,
      } as any),
    ),
  );

  // ---- Platform settings ----
  await prisma.platformSetting.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1, serviceFeePct: 5, coinsPerHundredEgp: 10, coinToEgpRate: 20 },
  });

  // ---- Users ----
  const passwordHash = await bcrypt.hash('Password123!', 10);

  // Keyed by email (unique, and what people log in with) so re-running against a database
  // whose demo accounts already exist under another phone updates them instead of failing.
  const admin = await prisma.user.upsert({
    where: { email: 'admin@matchena.com' },
    update: { name: 'Matchena Admin' },
    create: {
      phone: '+201000000001',
      email: 'admin@matchena.com',
      passwordHash,
      name: 'Matchena Admin',
      roles: ['admin'],
    },
  });

  const owner = await prisma.user.upsert({
    where: { email: 'owner@matchena.com' },
    update: { username: 'elmalek' },
    create: {
      phone: '+201000000002',
      email: 'owner@matchena.com',
      passwordHash,
      name: 'Ahmed El-Malek',
      username: 'elmalek',
      roles: ['owner'],
    },
  });

  const playerNames = [
    'Youssef Adel', 'Mariam Hassan', 'Omar Khaled', 'Salma Tarek', 'Kareem Fathy',
    'Nour El-Sayed', 'Ziad Mostafa', 'Habiba Ali', 'Mohamed Reda', 'Farida Samir',
  ];
  const players = await Promise.all(
    playerNames.map((name, i) =>
      prisma.user.upsert({
        where: { phone: `+2010000001${String(i).padStart(2, '0')}` },
        update: {
          email: `player${i}@matchena.com`,
          passwordHash,
        },
        create: {
          phone: `+2010000001${String(i).padStart(2, '0')}`,
          email: `player${i}@matchena.com`,
          passwordHash,
          name,
          roles: ['player'],
          coinsBalance: 100 + i * 20,
        },
      }),
    ),
  );

  // ---- Venues + courts + pricing ----
  const venueSeed = [
    { nameEn: 'El Dawlia Pitch', nameAr: 'ملعب الدولية', country: 'EG', district: 'dist-nasr-city', gov: cairo.id, lat: 30.0626, lng: 31.3428, sport: 'sport-football', currency: 'EGP' },
    { nameEn: 'Zed Padel Club', nameAr: 'زد بادل كلوب', country: 'EG', district: 'dist-sheikh-zayed', gov: giza.id, lat: 30.0107, lng: 30.9746, sport: 'sport-padel', currency: 'EGP' },
    { nameEn: 'Maadi Sporting Club', nameAr: 'نادي المعادي الرياضي', country: 'EG', district: 'dist-maadi', gov: cairo.id, lat: 29.9603, lng: 31.2569, sport: 'sport-tennis', currency: 'EGP' },
    { nameEn: 'New Cairo Courts', nameAr: 'ملاعب القاهرة الجديدة', country: 'EG', district: 'dist-new-cairo', gov: cairo.id, lat: 30.0271, lng: 31.4959, sport: 'sport-basketball', currency: 'EGP' },
    { nameEn: 'Heliopolis Squash Center', nameAr: 'مركز مصر الجديدة للاسكواش', country: 'EG', district: 'dist-heliopolis', gov: cairo.id, lat: 30.0875, lng: 31.3243, sport: 'sport-squash', currency: 'EGP' },
    { nameEn: 'Olaya Padel House', nameAr: 'أوليا بادل هاوس', country: 'SA', district: 'dist-olaya', gov: riyadh.id, lat: 24.6935, lng: 46.6852, sport: 'sport-padel', currency: 'SAR' },
    { nameEn: 'Marina Football Hub', nameAr: 'مارينا فوتبول هب', country: 'AE', district: 'dist-marina', gov: dubai.id, lat: 25.0809, lng: 55.1398, sport: 'sport-football-5', currency: 'AED' },
  ];

  for (const v of venueSeed) {
    const slug = venueSlug(v.country, v.nameEn);
    const duplicates = await prisma.venue.findMany({
      where: {
        nameEn: v.nameEn,
        countryCode: v.country,
        slug: { not: slug },
      },
      select: { id: true, slug: true },
    });
    for (const dupe of duplicates) {
      console.log(`Removing duplicate venue ${dupe.slug} → keep ${slug}`);
      await deleteVenueTree(dupe.id);
    }

    const venue = await prisma.venue.upsert({
      where: { slug },
      update: {
        countryCode: v.country,
        priceFromAmount: 12000,
        priceFromCurrency: v.currency,
      },
      create: {
        slug,
        ownerId: owner.id,
        countryCode: v.country,
        nameEn: v.nameEn,
        nameAr: v.nameAr,
        districtId: v.district,
        governorateId: v.gov,
        lat: v.lat,
        lng: v.lng,
        geohash: ngeohash.encode(v.lat, v.lng, 9),
        status: 'active',
        approvedById: admin.id,
        approvedAt: new Date(),
        priceFromAmount: 12000,
        priceFromCurrency: v.currency,
        sports: { create: [{ sportId: v.sport }] },
        amenities: {
          create: [{ amenity: { connect: { key: 'parking' } } }, { amenity: { connect: { key: 'floodlights' } } }],
        },
      },
    });

    const existingCourt = await prisma.court.findFirst({
      where: { venueId: venue.id },
    });
    if (existingCourt) continue;

    const court = await prisma.court.create({
      data: { venueId: venue.id, sportId: v.sport, name: 'Court 1', slotDurationMins: 60, indoor: false },
    });

    await prisma.pricingRule.createMany({
      data: [
        { courtId: court.id, label: 'base', daysOfWeek: [], startTime: '08:00', endTime: '17:00', priceAmount: 12000, currency: v.currency, priority: 0 },
        { courtId: court.id, label: 'peak', daysOfWeek: [], startTime: '17:00', endTime: '23:00', priceAmount: 20000, currency: v.currency, priority: 1 },
        { courtId: court.id, label: 'weekend', daysOfWeek: [5, 6], startTime: '00:00', endTime: '23:59', priceAmount: 22000, currency: v.currency, priority: 2 },
      ],
    });
  }

  // ---- Gaming expansion venues — see MATCHENA_GAMING_EXPANSION_BLUEPRINT.md §3.2/§7.3 ----
  {
    const gamingSlug = venueSlug('EG', 'Neon Arena Gaming Lounge');
    const gamingVenue = await prisma.venue.upsert({
      where: { slug: gamingSlug },
      update: { countryCode: 'EG', priceFromAmount: 15000, priceFromCurrency: 'EGP' },
      create: {
        slug: gamingSlug,
        ownerId: owner.id,
        countryCode: 'EG',
        nameEn: 'Neon Arena Gaming Lounge',
        nameAr: 'نيون أرينا للألعاب',
        districtId: 'dist-nasr-city',
        governorateId: cairo.id,
        lat: 30.0651,
        lng: 31.3459,
        geohash: ngeohash.encode(30.0651, 31.3459, 9),
        status: 'active',
        approvedById: admin.id,
        approvedAt: new Date(),
        priceFromAmount: 15000,
        priceFromCurrency: 'EGP',
        sports: { create: [{ sportId: 'sport-playstation' }] },
        amenities: {
          create: [{ amenity: { connect: { key: 'wifi' } } }, { amenity: { connect: { key: 'cafe' } } }],
        },
      },
    });
    const gamingCourts = await prisma.court.findMany({ where: { venueId: gamingVenue.id } });
    if (gamingCourts.length === 0) {
      const ps5Room = await prisma.court.create({
        data: {
          venueId: gamingVenue.id,
          sportId: 'sport-playstation',
          name: 'PS5 Room 1',
          slotDurationMins: 60,
          indoor: true,
          format: 'session',
          ageRating: 'teen',
          gamingConfig: { consoleType: 'ps5', seats: 4, roomTier: 'standard' },
        },
      });
      const vipRoom = await prisma.court.create({
        data: {
          venueId: gamingVenue.id,
          sportId: 'sport-playstation',
          name: 'VIP Big-Screen Room',
          slotDurationMins: 60,
          indoor: true,
          format: 'session',
          ageRating: 'teen',
          gamingConfig: { consoleType: 'ps5', seats: 6, roomTier: 'vip-big-screen' },
        },
      });
      for (const court of [
        { id: ps5Room.id, base: 15000, peak: 25000, weekend: 28000 },
        { id: vipRoom.id, base: 25000, peak: 40000, weekend: 45000 },
      ]) {
        await prisma.pricingRule.createMany({
          data: [
            { courtId: court.id, label: 'base', daysOfWeek: [], startTime: '10:00', endTime: '17:00', priceAmount: court.base, currency: 'EGP', priority: 0 },
            { courtId: court.id, label: 'peak', daysOfWeek: [], startTime: '17:00', endTime: '02:00', priceAmount: court.peak, currency: 'EGP', priority: 1 },
            { courtId: court.id, label: 'weekend', daysOfWeek: [5, 6], startTime: '00:00', endTime: '23:59', priceAmount: court.weekend, currency: 'EGP', priority: 2 },
          ],
        });
      }
    }

    const tableSlug = venueSlug('EG', 'Downtown Billiards And Ping Pong Club');
    const tableVenue = await prisma.venue.upsert({
      where: { slug: tableSlug },
      update: { countryCode: 'EG', priceFromAmount: 8000, priceFromCurrency: 'EGP' },
      create: {
        slug: tableSlug,
        ownerId: owner.id,
        countryCode: 'EG',
        nameEn: 'Downtown Billiards & Ping Pong Club',
        nameAr: 'نادي وسط البلد للبلياردو وتنس الطاولة',
        districtId: 'dist-maadi',
        governorateId: cairo.id,
        lat: 29.9615,
        lng: 31.2581,
        geohash: ngeohash.encode(29.9615, 31.2581, 9),
        status: 'active',
        approvedById: admin.id,
        approvedAt: new Date(),
        priceFromAmount: 8000,
        priceFromCurrency: 'EGP',
        sports: { create: [{ sportId: 'sport-billiards' }, { sportId: 'sport-table-tennis' }] },
        amenities: {
          create: [{ amenity: { connect: { key: 'parking' } } }, { amenity: { connect: { key: 'cafe' } } }],
        },
      },
    });
    const tableCourts = await prisma.court.findMany({ where: { venueId: tableVenue.id } });
    if (tableCourts.length === 0) {
      const billiardsTable = await prisma.court.create({
        data: {
          venueId: tableVenue.id,
          sportId: 'sport-billiards',
          name: 'Table 1',
          slotDurationMins: 45,
          indoor: true,
          format: 'session',
          tableConfig: { tableType: 'american-8-ball', rentalAvailable: true, rentalPrice: { amount: 3000, currency: 'EGP' } },
        },
      });
      const pingPongTable = await prisma.court.create({
        data: {
          venueId: tableVenue.id,
          sportId: 'sport-table-tennis',
          name: 'Table 1',
          slotDurationMins: 30,
          indoor: true,
          format: 'session',
          tableConfig: { rentalAvailable: true, rentalPrice: { amount: 1500, currency: 'EGP' } },
        },
      });
      for (const court of [
        { id: billiardsTable.id, base: 8000, peak: 12000, weekend: 14000 },
        { id: pingPongTable.id, base: 5000, peak: 8000, weekend: 9000 },
      ]) {
        await prisma.pricingRule.createMany({
          data: [
            { courtId: court.id, label: 'base', daysOfWeek: [], startTime: '10:00', endTime: '17:00', priceAmount: court.base, currency: 'EGP', priority: 0 },
            { courtId: court.id, label: 'peak', daysOfWeek: [], startTime: '17:00', endTime: '00:00', priceAmount: court.peak, currency: 'EGP', priority: 1 },
            { courtId: court.id, label: 'weekend', daysOfWeek: [5, 6], startTime: '00:00', endTime: '23:59', priceAmount: court.weekend, currency: 'EGP', priority: 2 },
          ],
        });
      }
    }
  }

  // ---- Promo code ----
  await prisma.promoCode.upsert({
    where: { code: 'WELCOME25' },
    update: {},
    create: {
      code: 'WELCOME25',
      type: 'percentage',
      value: 25,
      firstBookingOnly: true,
      usageLimitPerUser: 1,
      validFrom: new Date(),
      validUntil: new Date(Date.now() + 90 * 86_400_000),
      createdById: admin.id,
    },
  });

  // ---- Quests & badges ----
  // MATCHENA_ENGAGEMENT_ENGINE_BLUEPRINT.md §3/§4.1 — `rule.event` says which
  // event bumps this quest; `rule.scope` (omitted = every activity) narrows
  // it to one activityKind and/or one specific sportId/gameId. Same table,
  // same code path, for football and for a PlayStation booking alike.
  const quests: {
    key: string;
    titleEn: string;
    titleAr: string;
    rule: Record<string, unknown>;
    rewardCoins: number;
  }[] = [
    {
      key: 'weekly_3_bookings',
      titleEn: 'Play 3 times this week',
      titleAr: 'العب 3 مرات هذا الأسبوع',
      rule: { event: 'booking.completed', target: 3 },
      rewardCoins: 150,
    },
    {
      key: 'weekly_daily_checkins',
      titleEn: 'Open the app 5 days this week',
      titleAr: 'افتح التطبيق 5 أيام هذا الأسبوع',
      rule: { event: 'checkin.daily', target: 5 },
      rewardCoins: 100,
    },
    {
      key: 'weekly_gaming_station_2',
      titleEn: 'Book a gaming station twice this week',
      titleAr: 'احجز محطة ألعاب مرتين هذا الأسبوع',
      rule: {
        event: 'booking.completed',
        target: 2,
        scope: { activityKind: 'gaming-station' },
      },
      rewardCoins: 120,
    },
    {
      key: 'weekly_review_with_photo',
      titleEn: 'Leave a review with a photo',
      titleAr: 'اكتب تقييم مع صورة',
      rule: { event: 'review.submitted', target: 1 },
      rewardCoins: 100,
    },
  ];
  for (const q of quests) {
    await prisma.quest.upsert({
      where: { key: q.key },
      update: {},
      create: { ...q, rule: q.rule as any },
    });
  }

  const badges: {
    key: string;
    nameEn: string;
    nameAr: string;
    icon: string;
    descriptionEn?: string;
    descriptionAr?: string;
  }[] = [
    { key: 'night_owl', nameEn: 'Night Owl', nameAr: 'بومة الليل', icon: 'moon' },
    {
      key: 'first-timer',
      nameEn: 'First Timer',
      nameAr: 'أول مرة',
      icon: 'star-filled',
      descriptionEn: 'Completed your first booking',
      descriptionAr: 'أكملت أول حجز ليك',
    },
    {
      key: 'week-streak',
      nameEn: 'Week Streak',
      nameAr: 'أسبوع متواصل',
      icon: 'flame',
      descriptionEn: '7-day check-in streak',
      descriptionAr: 'استمرارية تسجيل دخول 7 أيام',
    },
    {
      key: 'iron-man',
      nameEn: 'Iron Man',
      nameAr: 'الرجل الحديدي',
      icon: 'flame',
      descriptionEn: '30-day check-in streak',
      descriptionAr: 'استمرارية تسجيل دخول 30 يوم',
    },
    {
      key: 'mvp-x5',
      nameEn: 'Fan Favorite',
      nameAr: 'نجم الملعب',
      icon: 'trophy',
      descriptionEn: 'Voted MVP 5 times',
      descriptionAr: 'اتفزت كأفضل لاعب 5 مرات',
    },
  ];
  for (const b of badges) {
    await prisma.badge.upsert({ where: { key: b.key }, update: {}, create: b });
  }

  // ---- Bilingual blog (one record per post, AR + EN fields) ----
  const guides = await prisma.blogCategory.upsert({
    where: { id: 'blog-cat-guides' },
    update: { nameEn: 'Guides', nameAr: 'أدلة' },
    create: { id: 'blog-cat-guides', nameEn: 'Guides', nameAr: 'أدلة' },
  });
  const news = await prisma.blogCategory.upsert({
    where: { id: 'blog-cat-news' },
    update: { nameEn: 'Play culture', nameAr: 'ثقافة اللعب' },
    create: { id: 'blog-cat-news', nameEn: 'Play culture', nameAr: 'ثقافة اللعب' },
  });

  const publishedAt = (daysAgo: number) =>
    new Date(Date.now() - daysAgo * 86_400_000);

  const posts = [
    {
      id: 'blog-book-padel',
      slug: 'how-to-book-a-padel-court',
      categoryId: guides.id,
      daysAgo: 2,
      coverImageUrl:
        'https://images.unsplash.com/photo-1554068865-24cecd4e34b8?auto=format&fit=crop&w=1600&q=80',
      titleEn: 'How to book a padel court in 60 seconds',
      titleAr: 'إزاي تحجز ملعب بادل في أقل من دقيقة',
      subtitleEn: 'Pick a slot, confirm, then show the QR at the gate.',
      subtitleAr: 'اختار الميعاد، أكّد، وورّي الـ QR عند البوابة.',
      contentEn: `<p>Open <strong>Explore</strong>, choose Padel, and filter by area or tonight.</p>
<p>Open the venue, pick a free slot, and confirm. Matchena holds that slot for a few minutes while you pay — card, e-wallet, or cash at the venue.</p>
<p>Once the booking is confirmed, a QR code appears. Show it at the gate for check-in.</p>
<p>On a first booking you can apply <strong>WELCOME25</strong> for 25% off, if the code is still active.</p>`,
      contentAr: `<p>افتح <strong>استكشف</strong>، اختار بادل، وصفّي حسب المنطقة أو معاد الليلة.</p>
<p>افتح الملعب، اختار ميعاد فاضي، وأكّد. ماتشنا بيثبّت المعاد دقايق وأنت بتدفع — بطاقة أو محفظة أو كاش في الملعب.</p>
<p>أول ما الحجز يتأكد يظهر كود QR. ورّيه عند البوابة للتشيك إن.</p>
<p>في أول حجز تقدر تستخدم <strong>WELCOME25</strong> خصم 25٪، لو الكود لسه شغّال.</p>`,
    },
    {
      id: 'blog-split-pay',
      slug: 'split-the-pitch-with-your-squad',
      categoryId: guides.id,
      daysAgo: 6,
      coverImageUrl:
        'https://images.unsplash.com/photo-1574629810360-7efbbe195018?auto=format&fit=crop&w=1600&q=80',
      titleEn: 'Split the pitch with your squad',
      titleAr: 'قسّم سعر الملعب على السكواد',
      subtitleEn: 'Each teammate pays their share from a private link.',
      subtitleAr: 'كل لاعب يدفع حصته من لينك خاص.',
      contentEn: `<p>When you confirm a booking you can split the total. You pay your share; everyone else gets a private pay link.</p>
<p>The booking stays open until every share is paid, and the amounts have to add up to the court total.</p>
<p>A cash share is settled at check-in. Card and wallet payments close as soon as they go through.</p>`,
      contentAr: `<p>وقت تأكيد الحجز تقدر تقسّم الإجمالي. تدفع حصتك، وباقي الفريق بياخد لينك دفع خاص.</p>
<p>الحجز يفضل مفتوح لحد ما كل حصة تتدفع، والمبالغ لازم تساوي سعر الملعب.</p>
<p>حصة الكاش بتتقفّل عند التشيك إن. البطاقة والمحفظة بتتأكد أول ما الدفع يعدي.</p>`,
    },
    {
      id: 'blog-coins-streaks',
      slug: 'coins-streaks-and-the-night-owl-badge',
      categoryId: news.id,
      daysAgo: 9,
      coverImageUrl:
        'https://images.unsplash.com/photo-1461896836934-ffe607ba6851?auto=format&fit=crop&w=1600&q=80',
      titleEn: 'Coins, streaks, and the Night Owl badge',
      titleAr: 'الكوينز، الستريك، وبادج بومة الليل',
      subtitleEn: 'Play, check in, and spend coins on the next slot.',
      subtitleAr: 'العب، اعمل تشيك إن، وصرف الكوينز على الميعاد الجاي.',
      contentEn: `<p>Confirmed bookings that you check in for add coins. A first completed session can also add a welcome bonus.</p>
<p>The wallet holds daily streaks and weekly quests — for example, book three times this week. Badges such as Night Owl show on your public profile.</p>
<p>Apply coins when you confirm the next booking. They come off the total before you pay the rest.</p>`,
      contentAr: `<p>الحجز المؤكد بعد التشيك إن بيزوّد الكوينز. أول جلسة مكتملة ممكن كمان تضيف بونص ترحيب.</p>
<p>المحفظة فيها الستريك اليومي والكويستات الأسبوعية — مثلًا احجز ثلاث مرات في الأسبوع. شارات زي بومة الليل بتظهر على بروفايلك العام.</p>
<p>صرف الكوينز وأنت بتأكد الحجز الجاي. بتتخصم من الإجمالي قبل ما تدفع الباقي.</p>`,
    },
    {
      id: 'blog-pulse',
      slug: 'matchena-pulse-fill-a-missing-player',
      categoryId: news.id,
      daysAgo: 12,
      coverImageUrl:
        'https://images.unsplash.com/photo-1431324155629-1a6deb1dec8d?auto=format&fit=crop&w=1600&q=80',
      titleEn: 'Matchena Pulse: fill a missing player tonight',
      titleAr: 'نبض ماتشنا: كمّل اللاعب الناقص الليلة',
      subtitleEn: 'Set yourself ready, then claim an open spot before the slot closes.',
      subtitleAr: 'حدّد إنك جاهز، وبعدين احجز المكان الفاضي قبل ما الميعاد يتقفل.',
      contentEn: `<p>Pulse shows matches that still need a player. Set when you can play (now, tonight, or the weekend), the sport, and how far you will travel.</p>
<p>If a side is short, it appears as a rescue spot. Claiming holds the seat briefly so you can confirm. If someone else takes it first, refresh and pick another opening.</p>
<p>Release the spot if you cannot make it — that keeps your reliability score clean.</p>`,
      contentAr: `<p>Pulse بيظهر الماتشات اللي لسه ناقصها لاعب. حدّد إمتى تقدر تلعب (دلوقتي، الليلة، أو الويكند)، الرياضة، والمسافة اللي تمشيها.</p>
<p>لو الطرف ناقص، بيظهر كمكان إنقاذ. الحجز بيثبّت المقعد شوية عشان تأكد. لو حد تاني أخده، حدّث الصفحة واختَر فرصة تانية.</p>
<p>حرّر المكان لو مش هتقدر تحضر — ده بيحافظ على درجة التزامك.</p>`,
    },
    {
      id: 'blog-cairo-districts',
      slug: 'where-to-play-this-weekend-in-cairo',
      categoryId: news.id,
      daysAgo: 16,
      coverImageUrl:
        'https://images.unsplash.com/photo-1577223625816-7546f13df25d?auto=format&fit=crop&w=1600&q=80',
      titleEn: 'Where to play this weekend in Cairo',
      titleAr: 'هتلعب فين الويكند في القاهرة',
      subtitleEn: 'Nasr City, Maadi, New Cairo, Sheikh Zayed — filter by area and sport.',
      subtitleAr: 'مدينة نصر، المعادي، القاهرة الجديدة، الشيخ زايد — فلتر حسب المنطقة والرياضة.',
      contentEn: `<p>Start in Explore, pick the sport, then narrow by district. Football in Nasr City, padel in Sheikh Zayed, tennis in Maadi, basketball in New Cairo, squash in Heliopolis — same booking flow.</p>
<p>The map and the list stay in sync. Times follow the venue’s local clock, so an evening slot in Cairo is evening in Cairo.</p>
<p>Weekend evenings often cost more than weekday afternoons. The price on the card is the price you confirm.</p>`,
      contentAr: `<p>ابدأ من استكشف، اختار الرياضة، وبعدين ضيّق على الحي. كرة في مدينة نصر، بادل في الشيخ زايد، تنس في المعادي، سلة في القاهرة الجديدة، اسكواش في مصر الجديدة — نفس طريقة الحجز.</p>
<p>الخريطة والقائمة ماشيين مع بعض. المواعيد على توقيت الملعب، فميعاد بالليل في القاهرة يبقى بالليل في القاهرة.</p>
<p>عصر الويكند غالبًا أغلى من بعد الظهر في نص الأسبوع. السعر على الكارت هو السعر اللي هتأكده.</p>`,
    },
  ];

  for (const post of posts) {
    await prisma.blogPost.upsert({
      where: { id: post.id },
      update: {
        slug: post.slug,
        titleEn: post.titleEn,
        titleAr: post.titleAr,
        subtitleEn: post.subtitleEn,
        subtitleAr: post.subtitleAr,
        coverImageUrl: post.coverImageUrl,
        contentEn: post.contentEn,
        contentAr: post.contentAr,
        categoryId: post.categoryId,
        authorId: admin.id,
        status: 'published',
        publishedAt: publishedAt(post.daysAgo),
      },
      create: {
        id: post.id,
        slug: post.slug,
        titleEn: post.titleEn,
        titleAr: post.titleAr,
        subtitleEn: post.subtitleEn,
        subtitleAr: post.subtitleAr,
        coverImageUrl: post.coverImageUrl,
        contentEn: post.contentEn,
        contentAr: post.contentAr,
        categoryId: post.categoryId,
        authorId: admin.id,
        status: 'published',
        publishedAt: publishedAt(post.daysAgo),
      },
    });
  }

  // ---- FAQ (production Help Center copy) ----
  const faqs = HELP_FAQS;
  for (const faq of faqs) {
    await prisma.faqEntry.upsert({
      where: { id: faq.id },
      update: faq,
      create: faq,
    });
  }

  // ---- Demo completed bookings + reviews (owner dashboard) ----
  const reviewVenues = await prisma.venue.findMany({
    where: { ownerId: owner.id, countryCode: 'EG' },
    include: { courts: { take: 1 } },
    orderBy: { nameEn: 'asc' },
    take: 4,
  });
  const reviewCopy = [
    {
      stars: 5,
      text: 'Pitch was in great shape and check-in took seconds. Will book again.',
      reply: 'Thanks for playing with us — see you next week!',
    },
    {
      stars: 4,
      text: 'Lights were excellent. Changing rooms could use more lockers.',
      reply: null,
    },
    {
      stars: 5,
      text: 'Staff were friendly and the court was ready on time.',
      reply: 'Appreciate the kind words. Game on.',
    },
  ];
  for (const [i, venue] of reviewVenues.entries()) {
    const court = venue.courts[0];
    const player = players[i];
    const copy = reviewCopy[i];
    if (!court || !player || !copy) continue;
    const start = new Date(Date.now() - (14 - i) * 86_400_000);
    start.setHours(18, 0, 0, 0);
    const end = new Date(start.getTime() + 60 * 60_000);
    const booking = await prisma.booking.upsert({
      where: { id: `seed-booking-review-${i}` },
      update: {
        courtId: court.id,
        venueId: venue.id,
        userId: player.id,
        slotStart: start,
        slotEnd: end,
        status: 'completed',
        paymentStatus: 'paid',
        checkedInAt: end,
      },
      create: {
        id: `seed-booking-review-${i}`,
        code: `SEEDREV${i}`,
        courtId: court.id,
        venueId: venue.id,
        userId: player.id,
        slotStart: start,
        slotEnd: end,
        baseAmount: 12000,
        feeAmount: 600,
        totalAmount: 12600,
        currency: venue.priceFromCurrency ?? 'EGP',
        paymentMethod: 'cash',
        paymentStatus: 'paid',
        status: 'completed',
        qrPayload: `seed-qr-review-${i}`,
        checkedInAt: end,
      },
    });
    await prisma.venueReview.upsert({
      where: {
        bookingId_userId: { bookingId: booking.id, userId: player.id },
      },
      update: {
        stars: copy.stars,
        text: copy.text,
        ownerReply: copy.reply ?? undefined,
        ownerRepliedAt: copy.reply ? new Date() : undefined,
      },
      create: {
        id: `seed-review-${i}`,
        venueId: venue.id,
        bookingId: booking.id,
        userId: player.id,
        stars: copy.stars,
        tags: ['clean', 'on_time'],
        text: copy.text,
        ownerReply: copy.reply ?? undefined,
        ownerRepliedAt: copy.reply ? new Date() : undefined,
      },
    });
    await prisma.venue.update({
      where: { id: venue.id },
      data: { ratingAvg: copy.stars, ratingCount: 1 },
    });
  }

  // Player0 can leave a review from the app (completed, no existing review).
  const reviewableVenue = reviewVenues[0];
  const reviewableCourt = reviewableVenue?.courts[0];
  if (reviewableVenue && reviewableCourt && players[0]) {
    const start = new Date(Date.now() - 3 * 86_400_000);
    start.setHours(19, 0, 0, 0);
    const end = new Date(start.getTime() + 60 * 60_000);
    await prisma.booking.upsert({
      where: { id: 'seed-booking-review-open' },
      update: {
        courtId: reviewableCourt.id,
        venueId: reviewableVenue.id,
        userId: players[0].id,
        slotStart: start,
        slotEnd: end,
        status: 'completed',
        paymentStatus: 'paid',
        checkedInAt: end,
      },
      create: {
        id: 'seed-booking-review-open',
        code: 'SEEDOPEN',
        courtId: reviewableCourt.id,
        venueId: reviewableVenue.id,
        userId: players[0].id,
        slotStart: start,
        slotEnd: end,
        baseAmount: 12000,
        feeAmount: 600,
        totalAmount: 12600,
        currency: reviewableVenue.priceFromCurrency ?? 'EGP',
        paymentMethod: 'cash',
        paymentStatus: 'paid',
        status: 'completed',
        qrPayload: 'seed-qr-review-open',
        checkedInAt: end,
      },
    });
  }

  await prisma.supportInquiry.upsert({
    where: { id: 'seed-support-1' },
    update: {},
    create: {
      id: 'seed-support-1',
      fullName: 'Karim Nabil',
      email: 'karim@example.com',
      phone: '+201111111111',
      message: 'The lights at El Dawlia went out mid-game last night. Can someone follow up with the owner?',
      status: 'new',
    },
  });
  await prisma.supportInquiry.upsert({
    where: { id: 'seed-support-2' },
    update: {},
    create: {
      id: 'seed-support-2',
      fullName: 'Sara Magdy',
      email: 'sara@example.com',
      phone: '+201222222222',
      message: 'I never received my refund after a cancelled padel booking. Booking code was M3-4821.',
      status: 'new',
    },
  });

  // ---- Demo teams ----
  const teamSeeds = [
    {
      id: 'team-cairo-kings',
      name: 'Cairo Kings',
      sportId: 'sport-football-5',
      captain: players[0],
      roster: players.slice(0, 4),
    },
    {
      id: 'team-padel-queens',
      name: 'Padel Queens',
      sportId: 'sport-padel',
      captain: players[1],
      roster: players.slice(1, 4),
    },
  ];
  for (const t of teamSeeds) {
    await prisma.team.upsert({
      where: { id: t.id },
      update: { name: t.name, sportId: t.sportId, captainId: t.captain.id },
      create: {
        id: t.id,
        name: t.name,
        sportId: t.sportId,
        captainId: t.captain.id,
        logoUrl: `https://picsum.photos/seed/${t.id}/128/128`,
      },
    });
    for (const member of t.roster) {
      await prisma.teamMember.upsert({
        where: { teamId_userId: { teamId: t.id, userId: member.id } },
        update: {},
        create: { teamId: t.id, userId: member.id },
      });
    }
  }

  // ---- Gaming expansion: game catalog, bundle, membership plans ----
  // Generic/placeholder titles only — never real publishers' names or box
  // art, per MATCHENA_GAMING_EXPANSION_BLUEPRINT.md §3.6/§12.
  await Promise.all(
    [
      { slug: 'football-champions', nameEn: 'Football Champions', nameAr: 'أبطال كرة القدم', genre: 'sports', ageRating: 'everyone' },
      { slug: 'street-racers', nameEn: 'Street Racers', nameAr: 'سباق الشوارع', genre: 'racing', ageRating: 'everyone' },
      { slug: 'tactical-strike', nameEn: 'Tactical Strike', nameAr: 'الهجوم التكتيكي', genre: 'shooter', ageRating: 'mature' },
      { slug: 'iron-fists', nameEn: 'Iron Fists', nameAr: 'قبضات حديدية', genre: 'fighting', ageRating: 'teen' },
      { slug: 'kart-rivals', nameEn: 'Kart Rivals', nameAr: 'منافسو الكارتينج', genre: 'racing', ageRating: 'everyone' },
      { slug: 'battle-arena', nameEn: 'Battle Arena', nameAr: 'ساحة المعركة', genre: 'shooter', ageRating: 'teen' },
    ].map((g) =>
      prisma.gameCatalogEntry.upsert({ where: { slug: g.slug }, update: {}, create: g }),
    ),
  );

  await Promise.all(
    [
      {
        slug: 'gaming-pass',
        nameEn: 'Matchena Gaming Pass',
        nameAr: 'اشتراك ماتشنا للألعاب',
        scope: 'gaming',
        priceAmount: 60000,
        priceCurrency: 'EGP',
        includedHours: 20,
        overageDiscountPercent: 15,
        perksEn: ['Priority Rescue Match matching', 'No service fee on gaming bookings'],
        perksAr: ['أولوية في مطابقة Rescue Match', 'بدون رسوم خدمة على حجوزات الألعاب'],
      },
      {
        slug: 'all-access',
        nameEn: 'Matchena All-Access',
        nameAr: 'اشتراك ماتشنا الشامل',
        scope: 'all-activities',
        priceAmount: 120000,
        priceCurrency: 'EGP',
        includedHours: 15,
        overageDiscountPercent: 10,
        perksEn: ['15% off every activity', 'Priority Rescue Match matching', 'Free coins bonus monthly'],
        perksAr: ['خصم 15% على كل الأنشطة', 'أولوية في مطابقة Rescue Match', 'مكافأة كوينز شهرية مجانية'],
      },
    ].map((p) =>
      prisma.membershipPlan.upsert({
        where: { slug: p.slug },
        update: { nameEn: p.nameEn, nameAr: p.nameAr },
        create: p,
      }),
    ),
  );

  const billiardsClub = await prisma.venue.findUnique({
    where: { slug: 'eg-downtown-billiards-and-ping-pong-club' },
    include: { courts: true },
  });
  if (billiardsClub && billiardsClub.courts.length >= 2) {
    const existingBundle = await prisma.bundle.findFirst({ where: { venueId: billiardsClub.id } });
    if (!existingBundle) {
      await prisma.bundle.create({
        data: {
          venueId: billiardsClub.id,
          nameEn: 'Billiards + Ping Pong Night',
          nameAr: 'ليلة بلياردو وبينج بونج',
          discountPercent: 15,
          items: {
            create: billiardsClub.courts.map((c) => ({ courtId: c.id, durationUnits: 1 })),
          },
        },
      });
    }
  }

  await prisma.commissionSetting.findFirst({ where: { venueId: null } }).then(async (global) => {
    if (global) {
      await prisma.commissionSetting.update({
        where: { id: global.id },
        data: { percentageBps: 1000 },
      });
    } else {
      await prisma.commissionSetting.create({
        data: { venueId: null, percentageBps: 1000 },
      });
    }
  });

  // A demo reception login so the team + permissions screens can be tried straight away:
  // it may see and create bookings, take payments and check players in — nothing else.
  const ownerVenues = await prisma.venue.findMany({ where: { ownerId: owner.id }, select: { id: true } });
  const reception = await prisma.user.upsert({
    where: { email: 'reception@matchena.com' },
    update: { status: 'active', roles: ['staff'] },
    create: {
      email: 'reception@matchena.com',
      emailVerifiedAt: new Date(),
      username: 'reception1',
      passwordHash,
      name: 'Mohamed Reception',
      roles: ['staff'],
    },
  });
  const receptionAccess = {
    ownerId: owner.id,
    title: 'Reception',
    permissions: ['bookings.view', 'bookings.create', 'bookings.checkin', 'payments.record', 'customers.view'],
    venueIds: ownerVenues.map((v) => v.id),
    createdById: owner.id,
  };
  await prisma.staffMember.upsert({
    where: { userId: reception.id },
    update: receptionAccess,
    create: { userId: reception.id, ...receptionAccess },
  });
  // Every venue gets a subscription (90 days), so the owner card and admin renewals list are never empty.
  for (const v of ownerVenues) {
    await prisma.venueSubscription.upsert({
      where: { venueId: v.id },
      update: {},
      create: { venueId: v.id, currentPeriodEnd: new Date(Date.now() + 90 * 86_400_000) },
    });
  }

  console.log('Seed complete.');
  console.log('---------------------------------------------');
  console.log('Admin login : admin@matchena.com / Password123!');
  console.log('Owner login : owner@matchena.com / Password123!');
  console.log('Reception   : reception1 (or reception@matchena.com) / Password123!  — limited staff account');
  console.log('Players     : phone +2010000010X (OTP via console, X=0..9)');
  console.log('---------------------------------------------');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
