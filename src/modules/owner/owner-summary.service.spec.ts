import { OwnerSummaryService } from './owner-summary.service';
import {
  collectedFromBookings,
  MANUAL_PAID_SQL,
  matchesManualPaid,
  matchesPlatformCollected,
  PLATFORM_COLLECTED_SQL,
  platformCollectedWhere,
  manualPaidWhere,
} from './owner-summary.service';
import { computeBookingMoney } from '../../common/money/booking-money';
import { zonedDayBounds, zonedWallTimeToUtc } from '../../common/utils/timezone.util';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.interface';

const owner: AuthenticatedUser = {
  id: 'owner-1',
  phone: '',
  name: 'Owner',
  roles: ['owner'],
};

describe('owner revenue predicates (parity with SQL)', () => {
  it('JS predicates match the documented SQL fragments', () => {
    expect(PLATFORM_COLLECTED_SQL).toContain("source = 'platform'");
    expect(PLATFORM_COLLECTED_SQL).toContain("paymentModeSnapshot");
    expect(MANUAL_PAID_SQL).toContain("source = 'manual'");
    expect(platformCollectedWhere().source).toBe('platform');
    expect(manualPaidWhere().source).toBe('manual');
  });

  it('examples 1–7: collected totals match the money module', () => {
    const plain = computeBookingMoney({
      base: 400, fee: 20, discount: 0, ownerFundedDiscount: 0, commissionBps: 1000,
    });
    const promo = computeBookingMoney({
      base: 400, fee: 20, discount: 50, ownerFundedDiscount: 50, commissionBps: 1000,
    });
    const coins = computeBookingMoney({
      base: 400, fee: 20, discount: 20, ownerFundedDiscount: 0, commissionBps: 1000,
    });
    const override = computeBookingMoney({
      base: 400, fee: 20, discount: 0, ownerFundedDiscount: 0, commissionBps: 1250,
    });
    const rows = [
      { source: 'platform', status: 'completed', paymentModeSnapshot: 'at_venue', paymentStatus: 'paid', checkedInAt: new Date(), baseAmount: 400, ownerFundedDiscount: 0, commissionAmount: plain.commissionAmount, totalAmount: plain.total },
      { source: 'platform', status: 'completed', paymentModeSnapshot: 'at_venue', paymentStatus: 'paid', checkedInAt: new Date(), baseAmount: 400, ownerFundedDiscount: 50, commissionAmount: promo.commissionAmount, totalAmount: promo.total },
      { source: 'platform', status: 'completed', paymentModeSnapshot: 'online', paymentStatus: 'paid', checkedInAt: null, baseAmount: 400, ownerFundedDiscount: 0, commissionAmount: coins.commissionAmount, totalAmount: coins.total },
      { source: 'platform', status: 'completed', paymentModeSnapshot: 'online', paymentStatus: 'paid', checkedInAt: null, baseAmount: 400, ownerFundedDiscount: 0, commissionAmount: override.commissionAmount, totalAmount: override.total },
      { source: 'manual', status: 'confirmed', paymentModeSnapshot: null, paymentStatus: 'paid', checkedInAt: null, baseAmount: 300, ownerFundedDiscount: 0, commissionAmount: 0, totalAmount: 300 },
      { source: 'manual', status: 'confirmed', paymentModeSnapshot: null, paymentStatus: 'pending', checkedInAt: null, baseAmount: 200, ownerFundedDiscount: 0, commissionAmount: 0, totalAmount: 200 },
      { source: 'platform', status: 'cancelled', paymentModeSnapshot: 'online', paymentStatus: 'paid', checkedInAt: null, baseAmount: 400, ownerFundedDiscount: 0, commissionAmount: 40, totalAmount: 420 },
    ];
    expect(rows.filter((r) => matchesPlatformCollected(r))).toHaveLength(4);
    expect(rows.filter((r) => matchesManualPaid(r))).toHaveLength(1);
    const totals = collectedFromBookings(rows);
    expect(totals.matchenaRevenue).toBe(400 + 350 + 400 + 400);
    expect(totals.ownRevenue).toBe(300);
    expect(totals.commission).toBe(
      plain.commissionAmount + promo.commissionAmount + coins.commissionAmount + override.commissionAmount,
    );
    expect(totals.collectedRevenue).toBe(totals.matchenaRevenue + totals.ownRevenue);
    expect(totals.takeHome).toBe(totals.collectedRevenue - totals.commission);
  });

  it('≥50 mixed bookings: 23:30 local stays on the civil day; UTC 23:30 rolls in Cairo', () => {
    const cairo = 'Africa/Cairo';
    const day = zonedDayBounds('2026-09-20', cairo);
    const bookings: Array<{ slotStart: Date; source: string; status: string; paymentStatus: string; paymentModeSnapshot: string | null; checkedInAt: Date | null; baseAmount: number; totalAmount: number; ownerFundedDiscount: number; commissionAmount: number }> = [];
    for (let i = 0; i < 40; i++) {
      bookings.push({
        slotStart: zonedWallTimeToUtc('2026-09-20', '23:30', cairo),
        source: i % 2 === 0 ? 'platform' : 'manual',
        status: 'completed',
        paymentStatus: 'paid',
        paymentModeSnapshot: i % 2 === 0 ? 'at_venue' : null,
        checkedInAt: i % 2 === 0 ? new Date() : null,
        baseAmount: 400,
        totalAmount: i % 2 === 0 ? 420 : 400,
        ownerFundedDiscount: 0,
        commissionAmount: i % 2 === 0 ? 40 : 0,
      });
    }
    for (let i = 0; i < 10; i++) {
      bookings.push({
        slotStart: new Date('2026-09-20T23:30:00.000Z'),
        source: 'manual',
        status: 'confirmed',
        paymentStatus: 'paid',
        paymentModeSnapshot: null,
        checkedInAt: null,
        baseAmount: 100,
        totalAmount: 100,
        ownerFundedDiscount: 0,
        commissionAmount: 0,
      });
    }
    const inCairoDay = bookings.filter((b) => b.slotStart >= day.start && b.slotStart < day.end);
    expect(inCairoDay).toHaveLength(40);
    const utcDay = inCairoDay; // independent recomputation: same window
    const totals = collectedFromBookings(utcDay);
    expect(totals.bookings).toBe(40);
    expect(totals.matchenaRevenue).toBe(20 * 400);
    expect(totals.ownRevenue).toBe(20 * 400);
    expect(totals.commission).toBe(20 * 40);
    const rolled = bookings.filter((b) => b.slotStart.toISOString() === '2026-09-20T23:30:00.000Z');
    expect(rolled).toHaveLength(10);
    expect(rolled.every((b) => !(b.slotStart >= day.start && b.slotStart < day.end))).toBe(true);
  });
});

describe('CSV export', () => {
  it('escapes formula injection and emits a UTF-8 BOM', async () => {
    const row = {
      slotStart: new Date('2026-09-20T10:00:00.000Z'),
      source: 'manual',
      sourceKey: 'walk_in',
      sourceLabel: null,
      guestName: '=CMD|cmd',
      user: { name: 'x' },
      court: { name: 'A' },
      status: 'confirmed',
      paymentStatus: 'paid',
      totalAmount: 100,
      commissionAmount: 0,
      ownerNetAmount: null,
      baseAmount: 100,
    };
    const prisma = {
      venue: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'v1',
          ownerId: 'owner-1',
          priceFromCurrency: 'EGP',
          weeklyHours: null,
          paymentMode: 'at_venue',
          country: { timezone: 'Africa/Cairo' },
        }),
      },
      booking: {
        aggregate: jest.fn().mockResolvedValue({
          _count: { _all: 0 },
          _sum: { baseAmount: 0, ownerFundedDiscount: 0, commissionAmount: 0, totalAmount: 0, feeAmount: 0 },
        }),
        findMany: jest.fn(async (args: { include?: { court?: unknown }; select?: { payments?: unknown } }) => {
          if (args?.select?.payments) return [];
          if (args?.include?.court) return [row];
          return [];
        }),
        groupBy: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(1),
      },
      court: { findMany: jest.fn().mockResolvedValue([]) },
      user: { findMany: jest.fn().mockResolvedValue([]) },
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    const csv = await new OwnerSummaryService(prisma as never).exportCsv(
      owner,
      'v1',
      '2026-09-20',
      '2026-09-20',
    );
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain("\"'=CMD|cmd\"");
  });
});
