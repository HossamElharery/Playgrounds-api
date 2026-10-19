/**
 * Real-Postgres harness for the booking integration suites. Builds the real
 * BookingsService (and the pieces it needs) on top of a throwaway database:
 * nothing about slot conflicts, hold expiry or notifications is mocked.
 */
const dbUrl = process.env.TEST_DATABASE_URL ?? '';
const dbName = dbUrl.split('?')[0].split('/').pop() ?? '';
if (!/(test|tmp)/.test(dbName)) {
  throw new Error(`Refusing to run integration tests against "${dbName}" (name must contain test/tmp)`);
}
process.env.DATABASE_URL = dbUrl;

import { PrismaService } from '../../src/modules/prisma/prisma.service';
import { BookingsService } from '../../src/modules/bookings/bookings.service';
import { BookingNotifier } from '../../src/modules/bookings/booking-notifier.service';
import { NotificationsService } from '../../src/modules/notifications/notifications.service';
import { CommissionService } from '../../src/modules/finance/commission.service';
import { LedgerService } from '../../src/modules/finance/ledger.service';
import { PaymentsConfigService } from '../../src/modules/payments/payments-config.service';
import { VenueListingService } from '../../src/modules/venues/venue-listing.service';
import type { AuthenticatedUser } from '../../src/common/types/authenticated-user.interface';

export const prisma = new PrismaService();

export const emitted: Array<{ userId: string; event: { type: string; [k: string]: unknown } }> = [];
const emitter = {
  emitToUser: (userId: string, event: { type: string }) => emitted.push({ userId, event }),
  emitToRoom: () => undefined,
  disconnectUser: () => undefined,
  revokeRoomAccess: () => undefined,
};
export const pushes: Array<{ userId: string; title: string; deepLink?: string | null }> = [];
const fcm = {
  sendToUser: async (userId: string, m: { title: string; deepLink?: string | null }) => {
    pushes.push({ userId, title: m.title, deepLink: m.deepLink });
  },
};
const webPush = { send: async () => undefined };

export const notifications = new NotificationsService(
  prisma,
  emitter as never,
  { get: () => undefined } as never,
  webPush as never,
  fcm as never,
);
export const notifier = new BookingNotifier(prisma, notifications, emitter as never);
const commission = new CommissionService(prisma, {} as never);
const ledger = new LedgerService(prisma, commission);
export const provider = { isLive: false, charge: jest.fn(), refund: jest.fn() };

export const bookings = new BookingsService(
  prisma,
  { get: () => 'qr-secret-'.repeat(5) } as never,
  provider as never,
  { onBookingCompleted: jest.fn() } as never,
  { debit: jest.fn(), credit: jest.fn() } as never,
  notifications,
  commission,
  ledger,
  new PaymentsConfigService(provider as never),
  notifier,
);
export const listing = new VenueListingService(prisma, notifications, emitter as never);

let seq = 0;
export const uniq = () => `${Date.now().toString(36)}${(seq += 1)}`;

export async function seedWorld() {
  await prisma.countryConfig.upsert({
    where: { code: 'EG' },
    update: {},
    create: {
      code: 'EG', nameEn: 'Egypt', nameAr: 'مصر', currency: 'EGP', phoneCallingCode: '+20',
      timezone: 'Africa/Cairo', locale: 'ar', paymentMethods: ['cash'],
    },
  });
  const sport = await prisma.sportCategory.upsert({
    where: { slug: 'it-football' },
    update: {},
    create: { slug: 'it-football', nameEn: 'Football', nameAr: 'كرة قدم', icon: 'football' },
  });
  return { sportId: sport.id };
}

export async function makeUser(label: string, roles: Array<'player' | 'owner' | 'staff' | 'admin'> = ['player']) {
  const id = uniq();
  const user = await prisma.user.create({
    data: { name: `${label} ${id}`, email: `${label}-${id}@matchena.test`, roles, countryCode: 'EG' },
  });
  return {
    row: user,
    auth: { id: user.id, roles, email: user.email, adminEdit: roles.includes('admin') } as unknown as AuthenticatedUser,
  };
}

const ALL_DAY = Object.fromEntries(
  [0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), { closed: false, open: '00:00', close: '23:59' }]),
);

export async function makeVenue(ownerId: string, sportId: string, courts = 2, patch: Record<string, unknown> = {}) {
  const id = uniq();
  const venue = await prisma.venue.create({
    data: {
      slug: `it-venue-${id}`, ownerId, countryCode: 'EG', currency: 'EGP',
      nameEn: `IT Venue ${id}`, nameAr: `ملعب ${id}`, address: '1 Test St', lat: 30.05, lng: 31.23,
      geohash: 'stq4s', status: 'active', instantBook: true, weeklyHours: ALL_DAY,
      approvedAt: new Date(), ...patch,
    },
  });
  const list: Awaited<ReturnType<typeof prisma.court.create>>[] = [];
  for (let i = 1; i <= courts; i += 1) {
    const court = await prisma.court.create({ data: { venueId: venue.id, sportId, name: `Court ${i}`, slotDurationMins: 60 } });
    await prisma.pricingRule.create({
      data: { courtId: court.id, label: 'base', daysOfWeek: [], startTime: '00:00', endTime: '24:00', priceAmount: 40000, currency: 'EGP', kind: 'base' },
    });
    list.push(court);
  }
  return { venue, courts: list };
}

/** An hour-aligned instant a few days ahead; `offsetHours` moves it by whole hours. */
export function futureSlot(offsetHours = 0, daysAhead = 5): Date {
  const d = new Date(Date.now() + daysAhead * 86_400_000);
  d.setUTCMinutes(0, 0, 0);
  d.setUTCHours(10 + offsetHours);
  return d;
}

export async function disconnect() {
  await prisma.$disconnect();
}
