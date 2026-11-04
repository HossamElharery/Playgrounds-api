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

describe('AdminService online users', () => {
  it('combines database heartbeats with live socket context', async () => {
    const user = {
      id: 'u-live', name: 'Live Player', username: 'live', avatarUrl: null,
      phone: null, email: 'live@example.com', roles: ['player'], lastSeenAt: new Date(),
      createdAt: new Date(), country: { code: 'EG', nameAr: 'مصر', nameEn: 'Egypt' },
      governorate: null, district: null,
    };
    const prisma = {
      user: {
        findMany: jest.fn().mockResolvedValue([user]),
        count: jest.fn().mockResolvedValue(1),
      },
    };
    const presence = {
      connectedUserIds: () => ['u-live'],
      inSquadUserIds: () => [],
      snapshot: () => ({
        connected: true, connectionCount: 2, connectedAt: new Date(),
        lastActivityAt: new Date(), inSquad: false, path: '/ar/community', device: 'mobile',
      }),
    };
    const service = new AdminService(prisma as never, presence as never);

    const result = await service.onlineUsers({ page: 1, perPage: 25, state: 'all' });

    expect(result.items[0]).toEqual(expect.objectContaining({
      id: 'u-live', presence: 'live', connectionCount: 2,
      currentPath: '/ar/community', device: 'mobile',
    }));
    expect(result.summary.online).toBe(1);
  });
});
