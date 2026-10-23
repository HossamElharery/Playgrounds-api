import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { BookingsService } from './bookings.service';
import { PrismaService } from '../prisma/prisma.service';
import { PAYMENT_PROVIDER } from '../payments/payment-provider.interface';
import { PAYMENT_GATEWAY } from '../payments/payment-gateway.interface';
import { RewardsService } from '../rewards/rewards.service';
import { WalletService } from '../payments/wallet.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CommissionService } from '../finance/commission.service';
import { LedgerService } from '../finance/ledger.service';
import { ApiException } from '../../common/errors/api-exception';
import { PaymentsConfigService } from '../payments/payments-config.service';
import { BookingNotifier } from './booking-notifier.service';

// A venue as the database stores a published, bookable one.
const LISTED = {
  instantBook: true,
  ownerListingEnabled: true,
  adminHidden: false,
  operationsEnabled: true,
} as const;

describe('BookingsService', () => {
  let service: BookingsService;
  const prisma = {
    booking: { findUnique: jest.fn(), updateMany: jest.fn(), findMany: jest.fn() },
    user: { update: jest.fn(), findUnique: jest.fn() },
    coinLedgerEntry: { create: jest.fn() },
    $transaction: jest.fn(),
    $queryRaw: jest.fn(),
  };
  const alignedFutureSlot = () => {
    const slot = new Date(Date.now() + 2 * 3_600_000);
    slot.setUTCMinutes(0, 0, 0);
    return slot.toISOString();
  };

  beforeEach(async () => {
    jest.resetAllMocks();
    prisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) =>
      fn(prisma),
    );
    prisma.$queryRaw.mockResolvedValue([]);
    prisma.booking.findMany.mockResolvedValue([]);
    prisma.user.findUnique.mockResolvedValue({ status: 'active' });
    const module = await Test.createTestingModule({
      providers: [
        BookingsService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: ConfigService,
          useValue: { get: () => 'test-secret-'.repeat(4) },
        },
        {
          provide: PAYMENT_PROVIDER,
          useValue: { charge: jest.fn(), refund: jest.fn() },
        },
        {
          provide: RewardsService,
          useValue: { onBookingCompleted: jest.fn(), payBookingCoins: jest.fn() },
        },
        {
          provide: WalletService,
          useValue: { debit: jest.fn(), credit: jest.fn() },
        },
        {
          provide: NotificationsService,
          useValue: { create: jest.fn().mockResolvedValue(null) },
        },
        {
          provide: CommissionService,
          useValue: { resolveBps: jest.fn().mockResolvedValue(1000) },
        },
        { provide: PaymentsConfigService, useValue: { isOnlinePaymentsLive: () => false, isGatewayLive: () => false } },
        { provide: PAYMENT_GATEWAY, useValue: { name: 'none', isLive: false } },
        { provide: BookingNotifier, useValue: { notifyVenueSide: jest.fn().mockResolvedValue(undefined) } },
        {
          provide: LedgerService,
          useValue: { syncBookingLedger: jest.fn().mockResolvedValue({ wrote: false, delta: 0, desired: 0 }) },
        },
      ],
    }).compile();

    service = module.get(BookingsService);
  });

  describe('refundPreviewPct', () => {
    it('offers a full refund 24+ hours before the slot', () => {
      const slotStart = new Date(Date.now() + 25 * 3_600_000);
      expect(service.refundPreviewPct(slotStart)).toBe(100);
    });

    it('offers a partial refund between 2 and 24 hours before the slot', () => {
      const slotStart = new Date(Date.now() + 5 * 3_600_000);
      expect(service.refundPreviewPct(slotStart)).toBe(50);
    });

    it('offers no refund inside the 2-hour cancellation window', () => {
      const slotStart = new Date(Date.now() + 30 * 60_000);
      expect(service.refundPreviewPct(slotStart)).toBe(0);
    });
  });

  it('reports reserved coins as restorable while a booking is still held', async () => {
    prisma.booking.findUnique.mockResolvedValue({
      id: 'b1', userId: 'u1', status: 'held', paymentStatus: 'unpaid',
      totalAmount: 5000, currency: 'EGP', coinsRedeemed: 300,
      slotStart: new Date(Date.now() + 3_600_000),
    });

    await expect(service.refundPreview('u1', 'b1')).resolves.toEqual(
      expect.objectContaining({ coinsRestored: 300 }),
    );
  });

  it('restores reserved coins when confirmation finds an expired hold', async () => {
    prisma.booking.findUnique.mockResolvedValue({
      id: 'b1', userId: 'u1', status: 'held',
      holdExpiresAt: new Date(Date.now() - 1000), coinsRedeemed: 300,
    });
    prisma.booking.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      service.confirmBooking('u1', 'b1', {}),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'HOLD_EXPIRED' }),
    });

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { coinsBalance: { increment: 300 } },
    });
    expect(prisma.coinLedgerEntry.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'u1', amount: 300, bookingId: 'b1',
      }),
    });
  });

  it('snapshots commission at hold so a later rate change cannot rewrite it', async () => {
    const court = {
      id: 'c1',
      venueId: 'v1',
      slotDurationMins: 60,
      pricingRules: [
        { daysOfWeek: [], startTime: '00:00', endTime: '24:00', priceAmount: 400, currency: 'EGP', priority: 0 },
      ],
      venue: {
        id: 'v1',
        status: 'active', ...LISTED,
        paymentMode: 'at_venue',
        currency: 'EGP',
        weeklyHours: Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), { closed: false, open: '00:00', close: '23:45' }])),
        country: { timezone: 'Africa/Cairo', currency: 'EGP', serviceFeePct: 5, coinToMajorRate: 20 },
      },
    };
    Object.assign(prisma, {
      court: { findUnique: jest.fn().mockResolvedValue(court) },
      platformSetting: { findUnique: jest.fn().mockResolvedValue({ serviceFeePct: 5, coinToEgpRate: 20 }) },
      resourceOccupancy: { findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]) },
    calendarBlock: { findFirst: jest.fn().mockResolvedValue(null) },
      booking: { ...prisma.booking, findFirst: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({ id: 'b-new' }) },
    });
    const created = await service.holdSlot('u1', { courtId: 'c1', slotStart: alignedFutureSlot() });
    expect(created.id).toBe('b-new');
    const data = (prisma as unknown as { booking: { create: jest.Mock } }).booking.create.mock.calls[0][0].data;
    expect(data.source).toBe('platform');
    expect(data.paymentModeSnapshot).toBe('at_venue');
    expect(data.commissionBps).toBe(1000);
    expect(data.commissionAmount).toBe(40);
    expect(data.ownerNetAmount).toBe(360);
    expect(data.totalAmount).toBe(data.baseAmount + data.feeAmount - data.discountAmount);
    expect(data.totalAmount).toBe(420);
  });

  it('rejects a second overlapping booking for the same player on another court', async () => {
    const court = {
      id: 'c2',
      venueId: 'v2',
      slotDurationMins: 60,
      gamingPublished: true,
      sport: { activityKind: 'field-sport' },
      pricingRules: [
        { daysOfWeek: [], startTime: '00:00', endTime: '24:00', priceAmount: 400, currency: 'EGP', priority: 0 },
      ],
      venue: {
        id: 'v2', status: 'active', ...LISTED, instantBook: true, paymentMode: 'at_venue', currency: 'EGP',
        weeklyHours: Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), { closed: false, open: '00:00', close: '23:59' }])),
        country: { timezone: 'Africa/Cairo', currency: 'EGP', serviceFeePct: 5, coinToMajorRate: 20 },
      },
    };
    Object.assign(prisma, {
      court: { findUnique: jest.fn().mockResolvedValue(court) },
      platformSetting: { findUnique: jest.fn().mockResolvedValue({ serviceFeePct: 5, coinToEgpRate: 20 }) },
      calendarBlock: { findFirst: jest.fn().mockResolvedValue(null) },
      resourceOccupancy: { findFirst: jest.fn().mockResolvedValue(null) },
      booking: {
        ...prisma.booking,
        findFirst: jest.fn()
          .mockResolvedValueOnce(null) // no live hold of this player on this very slot
          .mockResolvedValueOnce(null) // the court itself is free
          .mockResolvedValueOnce({ id: 'existing-on-other-court' }),
        create: jest.fn(),
      },
    });

    await expect(
      service.holdSlot('u1', { courtId: 'c2', slotStart: alignedFutureSlot() }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'USER_TIME_CONFLICT' }),
    });
    expect((prisma as any).booking.create).not.toHaveBeenCalled();
  });

  it('rejects a hand-crafted start time that is not in the published slot grid', async () => {
    const slot = new Date(alignedFutureSlot());
    slot.setUTCMinutes(17);
    Object.assign(prisma, {
      court: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'c1', venueId: 'v1', slotDurationMins: 60, gamingPublished: true,
          sport: { activityKind: 'field-sport' }, pricingRules: [],
          venue: {
            id: 'v1', status: 'active', ...LISTED, instantBook: true,
            weeklyHours: Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), { closed: false, open: '00:00', close: '23:59' }])),
            country: { timezone: 'Africa/Cairo' },
          },
        }),
      },
    });
    await expect(
      service.holdSlot('u1', { courtId: 'c1', slotStart: slot.toISOString() }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'INVALID_SLOT_START' }),
    });
  });

  describe('a venue that has not set its opening hours', () => {
    const noHoursCourt = {
      id: 'c1',
      venueId: 'v1',
      slotDurationMins: 60,
      pricingRules: [{ daysOfWeek: [], startTime: '00:00', endTime: '24:00', priceAmount: 400, currency: 'EGP', priority: 0 }],
      venue: { id: 'v1', status: 'active', ...LISTED, paymentMode: 'at_venue', currency: 'EGP', weeklyHours: null, country: { timezone: 'Africa/Cairo', currency: 'EGP' } },
    };

    it('offers no slots at all (it used to look open 24 hours)', async () => {
      Object.assign(prisma, { court: { findUnique: jest.fn().mockResolvedValue(noHoursCourt) } });
      await expect(service.getSlotGrid('c1', '2026-10-05')).resolves.toEqual([]);
    });

    it('refuses a player hold with VENUE_NOT_READY', async () => {
      Object.assign(prisma, { court: { findUnique: jest.fn().mockResolvedValue(noHoursCourt) } });
      await expect(
        service.holdSlot('u1', { courtId: 'c1', slotStart: new Date(Date.now() + 3_600_000).toISOString() }),
      ).rejects.toMatchObject({ response: expect.objectContaining({ code: 'VENUE_NOT_READY' }) });
    });
  });

  describe('an hour that the price list does not cover', () => {
    const court = (rules: unknown[]) => ({
      id: 'c1',
      venueId: 'v1',
      slotDurationMins: 60,
      pricingRules: rules,
      venue: {
        id: 'v1',
        status: 'active', ...LISTED,
        paymentMode: 'at_venue',
        currency: 'AED',
        weeklyHours: Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), { closed: false, open: '20:00', close: '23:59' }])),
        country: { timezone: 'Africa/Cairo', currency: 'AED', serviceFeePct: 5 },
      },
    });
    const wire = (c: unknown) =>
      Object.assign(prisma, {
        court: { findUnique: jest.fn().mockResolvedValue(c) },
        booking: { ...prisma.booking, findMany: jest.fn().mockResolvedValue([]) },
        resourceOccupancy: { findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]) },
    calendarBlock: { findMany: jest.fn().mockResolvedValue([]) },
      });

    it('is "unpriced" — never offered as free at price 0 or at another hour\'s price', async () => {
      // Open 20:00–24:00 but the tariff stops at 23:00.
      wire(court([{ daysOfWeek: [], startTime: '08:00', endTime: '23:00', priceAmount: 12000, currency: 'AED', priority: 0 }]));
      const grid = await service.getSlotGrid('c1', '2026-12-07');
      expect(grid.map((c) => [c.hhmm, c.state])).toEqual([
        ['20:00', 'available'],
        ['21:00', 'available'],
        ['22:00', 'available'],
        ['23:00', 'unpriced'],
      ]);
      expect(grid[0].priceAmount).toBe(12000);
    });

    it('marks every open hour unpriced when the court has no price at all', async () => {
      wire(court([]));
      const grid = await service.getSlotGrid('c1', '2026-12-07');
      expect(grid.length).toBeGreaterThan(0);
      expect(grid.every((c) => c.state === 'unpriced')).toBe(true);
    });

    it('rejects a booking whose start is priced but its remaining time is not', async () => {
      wire(court([{ daysOfWeek: [], startTime: '20:00', endTime: '23:00', priceAmount: 12000, currency: 'AED', priority: 0 }]));
      await expect(service.holdSlot('u1', { courtId: 'c1', slotStart: '2026-12-07T20:00:00.000Z', units: 3 })).rejects.toThrow('entire booking');
    });

    it('refuses a player hold on an uncovered hour', async () => {
      Object.assign(prisma, {
        court: {
          findUnique: jest.fn().mockResolvedValue(court([{ daysOfWeek: [], startTime: '08:00', endTime: '23:00', priceAmount: 12000, currency: 'AED', priority: 0 }])),
        },
      });
      // 23:00 Cairo on a December Monday = 21:00 UTC
      await expect(
        service.holdSlot('u1', { courtId: 'c1', slotStart: '2026-12-07T21:00:00.000Z' }),
      ).rejects.toThrow('no pricing configured');
    });
  });

  it.each(['suspended', 'pending'])('refuses a player hold on a %s venue even when the court id is known', async (status) => {
    Object.assign(prisma, {
      court: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'c1',
          venueId: 'v1',
          slotDurationMins: 60,
          pricingRules: [],
          venue: { id: 'v1', status, weeklyHours: null, country: { timezone: 'Africa/Cairo' } },
        }),
      },
    });
    await expect(
      service.holdSlot('u1', { courtId: 'c1', slotStart: '2026-12-07T20:00:00.000Z' }),
    ).rejects.toMatchObject({ response: expect.objectContaining({ code: 'VENUE_UNAVAILABLE' }) });
  });

  it('rejects online-only methods when the venue is at_venue', async () => {
    prisma.booking.findUnique.mockResolvedValue({
      id: 'b1',
      userId: 'u1',
      status: 'held',
      holdExpiresAt: new Date(Date.now() + 60_000),
      totalAmount: 420,
      currency: 'EGP',
      paymentModeSnapshot: 'at_venue',
      venue: { status: 'active', ...LISTED, paymentMode: 'at_venue', nameEn: 'X', nameAr: 'س' },
      promoCodeId: null,
    });
    await expect(service.confirmBooking('u1', 'b1', { paymentMethod: 'card' })).rejects.toBeInstanceOf(ApiException);
  });

  it('confirms as cash at the venue without touching the wallet while online payments are disabled', async () => {
    const held = {
      id: 'b1', code: 'MAT-TEST', userId: 'u1', status: 'held',
      holdExpiresAt: new Date(Date.now() + 60_000), totalAmount: 420,
      currency: 'EGP', paymentModeSnapshot: 'online', promoCodeId: null,
      venue: { status: 'active', ...LISTED, paymentMode: 'online', nameEn: 'QA Venue', nameAr: 'ملعب اختبار' },
    };
    const confirmed = { ...held, status: 'confirmed', paymentMethod: 'cash', paymentStatus: 'pending' };
    Object.assign(prisma, {
      venue: { findUnique: jest.fn().mockResolvedValue(held.venue) },
      booking: {
        ...prisma.booking,
        findUnique: jest.fn().mockResolvedValue(held),
        findUniqueOrThrow: jest.fn().mockResolvedValue(confirmed),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    });

    await expect(service.confirmBooking('u1', 'b1', { paymentMethod: 'cash' }))
      .resolves.toMatchObject({ paymentMethod: 'cash', paymentStatus: 'pending' });
    const wallet = (service as any).wallet as { debit: jest.Mock };
    expect(wallet.debit).not.toHaveBeenCalled();
    expect((prisma as any).booking.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ paymentMethod: 'cash', paymentStatus: 'pending' }),
      }),
    );
  });

  describe('venue state is enforced by the backend, not the screen', () => {
    const court = (venue: Record<string, unknown>) => ({
      id: 'c1', venueId: 'v1', slotDurationMins: 60, gamingPublished: true, pricingRules: [],
      venue: { id: 'v1', status: 'active', ...LISTED, weeklyHours: null, country: { timezone: 'Africa/Cairo' }, ...venue },
    });
    it.each([
      [{ ownerListingEnabled: false }, 'VENUE_UNAVAILABLE'],
      [{ adminHidden: true }, 'VENUE_UNAVAILABLE'],
      [{ instantBook: false }, 'VENUE_BOOKING_DISABLED'],
    ])('refuses a hold when %j', async (patch, expected) => {
      Object.assign(prisma, { court: { findUnique: jest.fn().mockResolvedValue(court(patch)) } });
      await expect(
        service.holdSlot('u1', { courtId: 'c1', slotStart: alignedFutureSlot() }),
      ).rejects.toMatchObject({ response: expect.objectContaining({ code: expected }) });
    });

    it('offers no slots for a hidden venue', async () => {
      Object.assign(prisma, { court: { findUnique: jest.fn().mockResolvedValue({ ...court({ adminHidden: true }), sport: null }) } });
      await expect(service.getSlotGrid('c1', '2026-12-07')).resolves.toEqual([]);
    });

    it('refuses a restricted account before doing anything else', async () => {
      prisma.user.findUnique.mockResolvedValue({ status: 'suspended' });
      Object.assign(prisma, { court: { findUnique: jest.fn().mockResolvedValue(court({ weeklyHours: { '0': { closed: false, open: '00:00', close: '23:59' } } })) } });
      await expect(
        service.holdSlot('u1', { courtId: 'c1', slotStart: alignedFutureSlot() }),
      ).rejects.toMatchObject({ response: expect.objectContaining({ code: 'ACCOUNT_RESTRICTED' }) });
    });

    it('releases the hold and reports the venue state when it is hidden before confirm', async () => {
      prisma.booking.findUnique.mockResolvedValue({
        id: 'b1', userId: 'u1', status: 'held', coinsRedeemed: 0, holdExpiresAt: new Date(Date.now() + 60_000),
        venue: { id: 'v1', status: 'active', ...LISTED, adminHidden: true },
      });
      prisma.booking.updateMany.mockResolvedValue({ count: 1 });
      await expect(service.confirmBooking('u1', 'b1', { paymentMethod: 'cash' })).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'VENUE_UNAVAILABLE' }),
      });
      expect(prisma.booking.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: 'cancelled', holdExpiresAt: null } }),
      );
    });
  });

  describe('split payment input', () => {
    const held = () => ({
      id: 'b1', userId: 'u1', status: 'held', totalAmount: 1000, coinsRedeemed: 0, holdExpiresAt: new Date(Date.now() + 60_000),
      venue: { id: 'v1', status: 'active', ...LISTED },
    });
    it.each([
      ['a zero share', [{ userId: 'u1', amount: 1000 }, { phone: '+201000000001', amount: 0 }], 'SPLIT_AMOUNT_INVALID'],
      ['a negative share', [{ userId: 'u1', amount: 1500 }, { phone: '+201000000001', amount: -500 }], 'SPLIT_AMOUNT_INVALID'],
      ['the same payer twice', [{ userId: 'u1', amount: 500 }, { userId: 'u1', amount: 500 }], 'SPLIT_DUPLICATE_PAYER'],
      ['shares that do not add up to the total', [{ userId: 'u1', amount: 400 }, { phone: '+201000000001', amount: 400 }], 'SPLIT_AMOUNT_MISMATCH'],
      ['no share for the organizer', [{ phone: '+201000000001', amount: 500 }, { phone: '+201000000002', amount: 500 }], 'SPLIT_ORGANIZER_SHARE_REQUIRED'],
    ])('rejects %s', async (_label, splitShares, expected) => {
      prisma.booking.findUnique.mockResolvedValue(held());
      await expect(service.confirmBooking('u1', 'b1', { splitShares } as never)).rejects.toThrow(expected);
    });
  });

  it('only offers online payment when the active provider is live', async () => {
    const payments = (service as unknown as { paymentsConfig: { isOnlinePaymentsLive(): boolean } }).paymentsConfig;
    expect(payments.isOnlinePaymentsLive()).toBe(false);
  });
});
