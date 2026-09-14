import { BadRequestException } from '@nestjs/common';
import { WalletService } from './wallet.service';

describe('WalletService', () => {
  const prisma = {
    user: {
      findUnique: jest.fn(),
      updateMany: jest.fn(),
      update: jest.fn(),
    },
    walletLedgerEntry: {
      create: jest.fn(),
      findMany: jest.fn(),
    },
  };
  const paymentProvider = { charge: jest.fn(), refund: jest.fn() };
  let service: WalletService;

  beforeEach(() => {
    jest.resetAllMocks();
    service = new WalletService(prisma as never, paymentProvider as never);
  });

  it('throws INSUFFICIENT_WALLET when the balance is too low', async () => {
    prisma.user.updateMany.mockResolvedValue({ count: 0 });
    prisma.user.findUnique.mockResolvedValue({ walletBalance: 1000 });

    await expect(
      service.debit(prisma as never, {
        userId: 'u1',
        amount: 29400,
        reason: 'booking',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    try {
      await service.debit(prisma as never, {
        userId: 'u1',
        amount: 29400,
        reason: 'booking',
      });
    } catch (err) {
      expect((err as BadRequestException).getResponse()).toEqual(
        expect.objectContaining({
          code: 'INSUFFICIENT_WALLET',
          result: { walletBalance: 1000, requiredAmount: 29400, shortfall: 28400 },
        }),
      );
    }
    expect(prisma.walletLedgerEntry.create).not.toHaveBeenCalled();
  });

  it('decrements atomically and writes a negative ledger row', async () => {
    prisma.user.updateMany.mockResolvedValue({ count: 1 });
    prisma.walletLedgerEntry.create.mockResolvedValue({});

    await service.debit(prisma as never, {
      userId: 'u1',
      amount: 5000,
      reason: 'booking',
      bookingId: 'b1',
    });

    expect(prisma.user.updateMany).toHaveBeenCalledWith({
      where: { id: 'u1', walletBalance: { gte: 5000 } },
      data: { walletBalance: { decrement: 5000 } },
    });
    expect(prisma.walletLedgerEntry.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'u1',
        amount: -5000,
        reason: 'booking',
        method: 'wallet',
        bookingId: 'b1',
      }),
    });
  });
});
