import { RewardsService, calendarDayKey } from './rewards.service';
import { PrismaService } from '../prisma/prisma.service';

describe('RewardsService.dailyCheckIn', () => {
  const prisma = {
    $transaction: jest.fn(),
    user: {
      findUniqueOrThrow: jest.fn(),
      update: jest.fn(),
    },
    coinLedgerEntry: { create: jest.fn() },
    quest: { findMany: jest.fn() },
  };

  let service: RewardsService;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => unknown) =>
      fn(prisma),
    );
    prisma.quest.findMany.mockResolvedValue([]);
    prisma.user.update.mockResolvedValue({});
    prisma.coinLedgerEntry.create.mockResolvedValue({});
    service = new RewardsService(prisma as unknown as PrismaService);
  });

  it('formats a Cairo calendar day as YYYY-MM-DD', () => {
    expect(calendarDayKey(new Date('2026-09-16T00:30:00.000Z'))).toBe('2026-09-16');
  });

  it('returns alreadyCheckedIn instead of throwing on a second visit the same day', async () => {
    prisma.user.findUniqueOrThrow.mockResolvedValue({
      id: 'u1',
      streakCount: 3,
      streakFreezes: 1,
      streakUpdatedAt: new Date(),
    });

    await expect(service.dailyCheckIn('u1')).resolves.toEqual({
      coins: 0,
      streak: 3,
      streakFreezes: 1,
      usedFreeze: false,
      alreadyCheckedIn: true,
    });
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.coinLedgerEntry.create).not.toHaveBeenCalled();
  });

  it('awards coins on the first visit of the day', async () => {
    prisma.user.findUniqueOrThrow.mockResolvedValue({
      id: 'u1',
      streakCount: 0,
      streakFreezes: 0,
      streakUpdatedAt: null,
    });

    await expect(service.dailyCheckIn('u1')).resolves.toEqual({
      coins: 5,
      streak: 1,
      streakFreezes: 0,
      usedFreeze: false,
      alreadyCheckedIn: false,
    });
    expect(prisma.user.update).toHaveBeenCalled();
    expect(prisma.coinLedgerEntry.create).toHaveBeenCalled();
  });
});
