import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { AdminService } from './admin.service';

describe('AdminService moderation reports', () => {
  const prisma = {
    user: { findFirst: jest.fn() },
    moderationReport: {
      count: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
    },
  };
  const service = new AdminService(prisma as never);

  beforeEach(() => jest.resetAllMocks());

  it('rejects reporting yourself', async () => {
    await expect(
      service.createReport('u1', {
        entityType: 'player', entityId: 'u1', reportedUserId: 'u1', reason: 'spam',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.moderationReport.create).not.toHaveBeenCalled();
  });

  it('rate-limits abusive report flooding', async () => {
    prisma.user.findFirst.mockResolvedValue({ id: 'u2' });
    prisma.moderationReport.count.mockResolvedValue(20);
    await expect(
      service.createReport('u1', {
        entityType: 'player', entityId: 'u2', reportedUserId: 'u2', reason: 'spam',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('deduplicates an already-open report instead of flooding moderation', async () => {
    const existing = { id: 'r1', status: 'open' };
    prisma.user.findFirst.mockResolvedValue({ id: 'u2' });
    prisma.moderationReport.count.mockResolvedValue(1);
    prisma.moderationReport.findFirst.mockResolvedValue(existing);
    await expect(
      service.createReport('u1', {
        entityType: 'player', entityId: 'u2', reportedUserId: 'u2', reason: 'harassment',
      }),
    ).resolves.toBe(existing);
    expect(prisma.moderationReport.create).not.toHaveBeenCalled();
  });
});
