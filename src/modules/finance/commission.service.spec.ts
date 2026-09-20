import { BadRequestException } from '@nestjs/common';
import { CommissionService } from './commission.service';

describe('CommissionService', () => {
  const prisma = {
    commissionSetting: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      upsert: jest.fn(),
      delete: jest.fn(),
      update: jest.fn(),
      create: jest.fn(),
    },
    venue: { findUnique: jest.fn(), count: jest.fn() },
    auditLogEntry: { create: jest.fn() },
    $transaction: jest.fn(),
  };
  const notifications = { create: jest.fn().mockResolvedValue(null) };
  let service: CommissionService;

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(prisma));
    service = new CommissionService(prisma as never, notifications as never);
  });

  it('resolves venue override → global → 1000', async () => {
    prisma.commissionSetting.findUnique.mockResolvedValue({ percentageBps: 1250 });
    await expect(service.resolveBps('v1')).resolves.toBe(1250);

    prisma.commissionSetting.findUnique.mockResolvedValue(null);
    prisma.commissionSetting.findFirst.mockResolvedValue({ percentageBps: 1000 });
    await expect(service.resolveBps('v1')).resolves.toBe(1000);

    prisma.commissionSetting.findFirst.mockResolvedValue(null);
    await expect(service.resolveBps('v1')).resolves.toBe(1000);
  });

  it('rejects bps outside 0..5000', async () => {
    prisma.venue.findUnique.mockResolvedValue({ id: 'v1', ownerId: 'o1' });
    await expect(service.setVenueBps('v1', 5001, 'admin', 'too high')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('upserts a venue override and writes an audit entry', async () => {
    prisma.venue.findUnique.mockResolvedValue({ id: 'v1', ownerId: 'o1' });
    prisma.commissionSetting.findUnique.mockResolvedValue(null);
    prisma.commissionSetting.findFirst.mockResolvedValue({ percentageBps: 1000 });
    prisma.commissionSetting.upsert.mockResolvedValue({});
    const result = await service.setVenueBps('v1', 1250, 'admin', 'padel peak');
    expect(prisma.commissionSetting.upsert).toHaveBeenCalled();
    expect(prisma.auditLogEntry.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'venue.commission.updated',
        actorUserId: 'admin',
      }),
    });
    expect(result.appliesTo).toBe('new_bookings_only');
  });
});
