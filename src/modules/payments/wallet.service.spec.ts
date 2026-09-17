import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
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
    walletWithdrawalRequest: {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      findMany: jest.fn(),
    },
    $transaction: jest.fn(),
  };
  const paymentProvider = { charge: jest.fn(), refund: jest.fn() };
  const notifications = { create: jest.fn().mockResolvedValue(null) };
  let service: WalletService;

  beforeEach(() => {
    jest.resetAllMocks();
    notifications.create.mockResolvedValue(null);
    prisma.$transaction.mockImplementation((arg: unknown) =>
      typeof arg === 'function' ? (arg as (tx: unknown) => unknown)(prisma) : Promise.all(arg as Promise<unknown>[]),
    );
    service = new WalletService(prisma as never, paymentProvider as never, notifications as never);
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

  describe('withdrawals', () => {
    it('reserves the funds and files a pending request in the same step', async () => {
      prisma.user.updateMany.mockResolvedValue({ count: 1 });
      prisma.walletWithdrawalRequest.create.mockResolvedValue({ id: 'w1', status: 'pending', amount: 10000 });

      const result = await service.requestWithdrawal('u1', 10000, '01000000000 (Vodafone Cash)');

      expect(prisma.user.updateMany).toHaveBeenCalledWith({
        where: { id: 'u1', walletBalance: { gte: 10000 } },
        data: { walletBalance: { decrement: 10000 } },
      });
      expect(prisma.walletWithdrawalRequest.create).toHaveBeenCalledWith({
        data: { userId: 'u1', amount: 10000, destination: '01000000000 (Vodafone Cash)' },
      });
      expect(result).toEqual({ id: 'w1', status: 'pending', amount: 10000 });
    });

    it('never files a request if the wallet cannot cover it', async () => {
      prisma.user.updateMany.mockResolvedValue({ count: 0 });
      prisma.user.findUnique.mockResolvedValue({ walletBalance: 500 });
      await expect(service.requestWithdrawal('u1', 10000, 'x')).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.walletWithdrawalRequest.create).not.toHaveBeenCalled();
    });

    it('refunds the wallet when an admin rejects the request', async () => {
      prisma.walletWithdrawalRequest.findUnique.mockResolvedValue({ id: 'w1', userId: 'u1', amount: 10000, status: 'pending' });
      prisma.user.update.mockResolvedValue({});
      prisma.walletLedgerEntry.create.mockResolvedValue({});
      prisma.walletWithdrawalRequest.update.mockResolvedValue({});

      await service.resolveWithdrawal('admin1', 'w1', 'rejected', 'bad destination');

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'u1' },
        data: { walletBalance: { increment: 10000 } },
      });
      expect(prisma.walletLedgerEntry.create).toHaveBeenCalledWith({
        data: { userId: 'u1', amount: 10000, reason: 'refund' },
      });
      expect(prisma.walletWithdrawalRequest.update).toHaveBeenCalledWith({
        where: { id: 'w1' },
        data: expect.objectContaining({ status: 'rejected', note: 'bad destination', resolvedByUserId: 'admin1' }),
      });
      expect(notifications.create).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1' }));
    });

    it('does not touch the wallet when marking a withdrawal paid', async () => {
      prisma.walletWithdrawalRequest.findUnique.mockResolvedValue({ id: 'w1', userId: 'u1', amount: 10000, status: 'pending' });
      prisma.walletWithdrawalRequest.update.mockResolvedValue({});

      await service.resolveWithdrawal('admin1', 'w1', 'paid');

      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(prisma.walletWithdrawalRequest.update).toHaveBeenCalledWith({
        where: { id: 'w1' },
        data: expect.objectContaining({ status: 'paid' }),
      });
    });

    it('refuses to resolve a request twice', async () => {
      prisma.walletWithdrawalRequest.findUnique.mockResolvedValue({ id: 'w1', userId: 'u1', amount: 10000, status: 'paid' });
      await expect(service.resolveWithdrawal('admin1', 'w1', 'paid')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('throws when the withdrawal request does not exist', async () => {
      prisma.walletWithdrawalRequest.findUnique.mockResolvedValue(null);
      await expect(service.resolveWithdrawal('admin1', 'missing', 'paid')).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
