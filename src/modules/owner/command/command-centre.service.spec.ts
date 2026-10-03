import { ForbiddenException } from '@nestjs/common';
import { attentionScore, CommandCentreService } from './command-centre.service';

const owner = { id: 'o1', roles: ['owner'] } as never;
const DAY = 86_400_000;

const venues = [
  { id: 'v-eg', nameAr: 'المعادي', nameEn: 'Maadi', status: 'active', currency: 'EGP', country: { timezone: 'Africa/Cairo' } },
  { id: 'v-ae', nameAr: 'مارينا', nameEn: 'Marina', status: 'active', currency: 'AED', country: { timezone: 'Asia/Dubai' } },
  { id: 'v-new', nameAr: 'جديد', nameEn: 'Newcomer', status: 'pending', currency: 'EGP', country: { timezone: 'Africa/Cairo' } },
];

function build(over: { staff?: { permissions: string[]; venueIds: string[]; ownerId: string } | null } = {}) {
  const owedRow = (venueId: string, outstanding: number, start: number) => ({
    id: `${venueId}-${start}`, venueId, code: 'C', guestName: 'G', court: { name: 'P' },
    slotStart: new Date(Date.now() + start), slotEnd: new Date(Date.now() + start + 3_600_000),
    totalAmount: outstanding, currency: venues.find((v) => v.id === venueId)!.currency, payments: [],
  });
  const prisma = {
    venue: {
      findMany: jest.fn().mockResolvedValue(venues),
      findUnique: jest.fn().mockImplementation(({ where }: { where: { id: string } }) =>
        Promise.resolve(where.id === 'v-new' ? { weeklyHours: null, lat: 0, lng: 0, address: '' } : { weeklyHours: { 0: { closed: false, open: '08:00', close: '23:00' } }, lat: 30, lng: 31, address: 'x' }),
      ),
    },
    court: { findMany: jest.fn().mockResolvedValue([{ _count: { pricingRules: 1 } }]) },
    booking: {
      count: jest.fn().mockImplementation(({ where }: { where: { venueId: string } }) => Promise.resolve(where.venueId === 'v-eg' ? 6 : 2)),
      findMany: jest.fn().mockImplementation(({ where }: { where: { venueId: string; slotEnd?: unknown } }) => {
        // Egypt: a finished 120 debt. Dubai: an upcoming 40 balance. Newcomer: nothing.
        if (where.venueId === 'v-eg' && where.slotEnd && (where.slotEnd as { lt?: Date }).lt) return Promise.resolve([owedRow('v-eg', 12_000, -2 * DAY)]);
        if (where.venueId === 'v-ae' && where.slotEnd && (where.slotEnd as { gte?: Date }).gte) return Promise.resolve([owedRow('v-ae', 4_000, DAY)]);
        return Promise.resolve([]);
      }),
    },
    payment: { groupBy: jest.fn().mockImplementation(({ where }: { where: { booking: { venueId: string } } }) => Promise.resolve(where.booking.venueId === 'v-eg' ? [{ recordedByUserId: 'a' }, { recordedByUserId: 'b' }] : [])) },
    cashHandover: { count: jest.fn().mockResolvedValue(0) },
    cashShift: { count: jest.fn().mockImplementation(({ where }: { where: { venueId: string } }) => Promise.resolve(where.venueId === 'v-ae' ? 1 : 0)) },
    staffMember: { findUnique: jest.fn().mockResolvedValue(over.staff ?? null) },
  };
  const summary = { cashbook: jest.fn().mockImplementation((id: string) => Promise.resolve({ received: id === 'v-eg' ? 50_000 : id === 'v-ae' ? 20_000 : 0 })) };
  return { service: new CommandCentreService(prisma as never, summary as never), prisma };
}

describe('CommandCentreService', () => {
  it('gives every venue its own row with today, what is owed, open drawers and what is stopping bookings', async () => {
    const { service } = build();
    const out = await service.centre(owner);
    const eg = out.venues.find((v) => v.id === 'v-eg')!;
    expect(eg).toMatchObject({ todayBookings: 6, receivedToday: 50_000, currency: 'EGP', blockers: [] });
    expect(eg.owed).toMatchObject({ overdue: 12_000, overdueCount: 1 });
    expect(eg.drawers).toEqual({ open: 2, handovers: 0, toReview: 0 });
    const ae = out.venues.find((v) => v.id === 'v-ae')!;
    expect(ae.owed).toMatchObject({ upcoming: 4_000, upcomingCount: 1 });
    expect(ae.drawers?.toReview).toBe(1);
    expect(out.venues.find((v) => v.id === 'v-new')!.blockers).toEqual(['hours', 'location']);
  });

  it('never adds money across currencies', async () => {
    const { service } = build();
    const out = await service.centre(owner);
    expect(out.totalsByCurrency).toEqual(
      expect.arrayContaining([
        { currency: 'EGP', receivedToday: 50_000, owed: 12_000 },
        { currency: 'AED', receivedToday: 20_000, owed: 4_000 },
      ]),
    );
    expect(out.totalsByCurrency).toHaveLength(2);
  });

  it('puts the venues that need the owner first', async () => {
    const { service } = build();
    const out = await service.centre(owner);
    // Maadi: debt (2) + open drawers (1) = 3. Marina: shift to review = 2.
    // Newcomer is still in review (pending): it is not running yet, so it sits last and does not count as "needs you".
    expect(out.venues.map((v) => v.id)).toEqual(['v-eg', 'v-ae', 'v-new']);
    expect(out.venues[2].attention).toBe(0);
    expect(out.needAttention).toBe(2);
  });

  it('shows staff only the venues they were given, and no drawer data without shifts.review', async () => {
    const { service, prisma } = build({ staff: { permissions: ['bookings.view'], venueIds: ['v-eg'], ownerId: 'o1' } });
    const out = await service.centre({ id: 's1', roles: ['staff'] } as never);
    expect(prisma.venue.findMany.mock.calls[0][0].where).toEqual({ ownerId: 'o1', id: { in: ['v-eg'] } });
    expect(out.venues.every((v) => v.drawers === null)).toBe(true);
  });

  it('refuses staff who cannot even see bookings', async () => {
    const { service } = build({ staff: { permissions: ['reports.view'], venueIds: ['v-eg'], ownerId: 'o1' } });
    await expect(service.centre({ id: 's1', roles: ['staff'] } as never)).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('attentionScore', () => {
  it('is zero for a calm, bookable venue', () => {
    expect(attentionScore({ owed: { overdue: 0, overdueCount: 0, upcoming: 900, upcomingCount: 1 }, drawers: { open: 0, handovers: 0, toReview: 0 }, blockers: [] })).toBe(0);
  });
});

describe('attentionScore for a venue that is not live', () => {
  const busy = { owed: { overdue: 5000, overdueCount: 2, upcoming: 0, upcomingCount: 0 }, drawers: { open: 1, handovers: 0, toReview: 1 }, blockers: ['hours'] as never };
  it('does not nag about a venue still in review or paused', () => {
    expect(attentionScore({ ...busy, status: 'pending' })).toBe(0);
    expect(attentionScore({ ...busy, status: 'suspended' })).toBe(0);
  });
  it('still counts an active venue the same way', () => {
    expect(attentionScore({ ...busy, status: 'active' })).toBeGreaterThan(0);
  });
});
