import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { BookingsService } from './bookings.service';
import { PrismaService } from '../prisma/prisma.service';
import { PAYMENT_PROVIDER } from '../payments/payment-provider.interface';
import { RewardsService } from '../rewards/rewards.service';
import { WalletService } from '../payments/wallet.service';
import { NotificationsService } from '../notifications/notifications.service';

describe('BookingsService', () => {
  let service: BookingsService;
  const prisma = {
    booking: { findUnique: jest.fn(), updateMany: jest.fn() },
    user: { update: jest.fn() },
    coinLedgerEntry: { create: jest.fn() },
    $transaction: jest.fn(),
  };

  beforeEach(async () => {
    jest.resetAllMocks();
    prisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) =>
      fn(prisma),
    );
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
          useValue: { onBookingCompleted: jest.fn() },
        },
        {
          provide: WalletService,
          useValue: { debit: jest.fn(), credit: jest.fn() },
        },
        {
          provide: NotificationsService,
          useValue: { create: jest.fn().mockResolvedValue(null) },
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
    ).rejects.toThrow('PULSE_EXPIRED');

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
});
