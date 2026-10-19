/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any, @typescript-eslint/unbound-method */
import {
  MessageTrustService,
  QUOTA_WINDOW_MS,
  STRANGER_LIMITS,
} from './message-trust.service';

const DAY = 24 * 60 * 60 * 1000;

describe('MessageTrustService', () => {
  const prisma: any = {
    user: { findUniqueOrThrow: jest.fn() },
    userBlock: { findMany: jest.fn() },
    moderationReport: { findMany: jest.fn() },
    chatThread: {
      findMany: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      update: jest.fn(),
    },
    chatMessage: { count: jest.fn(), findMany: jest.fn() },
    friendship: { findFirst: jest.fn() },
    teamMember: { findFirst: jest.fn() },
    matchPost: { findFirst: jest.fn() },
    $executeRaw: jest.fn(),
    $transaction: jest.fn((cb: (tx: unknown) => unknown) => cb(prisma)),
  };
  const service = new MessageTrustService(prisma);
  const account = (over: Record<string, unknown> = {}) => ({
    createdAt: new Date(Date.now() - 30 * DAY),
    emailVerifiedAt: new Date(),
    phone: null,
    matchesPlayed: 0,
    strangerContactLimit: null,
    ...over,
  });

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.$transaction.mockImplementation((cb: (tx: unknown) => unknown) =>
      cb(prisma),
    );
    prisma.user.findUniqueOrThrow.mockResolvedValue(account());
    prisma.userBlock.findMany.mockResolvedValue([]);
    prisma.moderationReport.findMany.mockResolvedValue([]);
    prisma.chatThread.findMany.mockResolvedValue([]);
  });

  describe('trust tiers', () => {
    it('gives a brand-new account the lowest cap', async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue(
        account({ createdAt: new Date(Date.now() - 3600_000) }),
      );
      await expect(service.quota('u')).resolves.toMatchObject({
        tier: 'new',
        limit: STRANGER_LIMITS.new,
      });
    });
    it('treats an old but unverified account as new', async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue(
        account({ emailVerifiedAt: null, phone: null }),
      );
      await expect(service.quota('u')).resolves.toMatchObject({
        tier: 'new',
        limit: 2,
      });
    });
    it('a phone-verified account counts as verified', async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue(
        account({ emailVerifiedAt: null, phone: '+201000000000' }),
      );
      await expect(service.quota('u')).resolves.toMatchObject({
        tier: 'standard',
        limit: 5,
      });
    });
    it('promotes an established player with finished matches', async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue(
        account({ matchesPlayed: 4 }),
      );
      await expect(service.quota('u')).resolves.toMatchObject({
        tier: 'trusted',
        limit: 10,
      });
    });
    it('does not promote an old account that never played', async () => {
      await expect(service.quota('u')).resolves.toMatchObject({
        tier: 'standard',
        limit: 5,
      });
    });
  });

  describe('strikes', () => {
    it('restricts after two different people block or report the sender', async () => {
      prisma.userBlock.findMany.mockResolvedValue([{ blockerId: 'a' }]);
      prisma.moderationReport.findMany.mockResolvedValue([{ reporterId: 'b' }]);
      await expect(service.quota('u')).resolves.toMatchObject({
        restricted: true,
        limit: 0,
        remaining: 0,
      });
    });
    it('counts one person blocking and reporting only once', async () => {
      prisma.userBlock.findMany.mockResolvedValue([{ blockerId: 'a' }]);
      prisma.moderationReport.findMany.mockResolvedValue([{ reporterId: 'a' }]);
      await expect(service.quota('u')).resolves.toMatchObject({
        restricted: false,
        limit: 5,
      });
    });
    it('only counts blocks from people the sender cold-messaged', async () => {
      await service.quota('u');
      expect(prisma.userBlock.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            blocker: {
              chatParticipants: { some: { thread: { requestedById: 'u' } } },
            },
          }),
        }),
      );
    });
    it('ignores dismissed reports', async () => {
      await service.quota('u');
      expect(prisma.moderationReport.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: { not: 'dismissed' } }),
        }),
      );
    });
  });

  describe('admin override', () => {
    it('wins over the tier and over an automatic restriction', async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue(
        account({ strangerContactLimit: 20 }),
      );
      prisma.userBlock.findMany.mockResolvedValue([
        { blockerId: 'a' },
        { blockerId: 'b' },
      ]);
      await expect(service.quota('u')).resolves.toMatchObject({
        limit: 20,
        overridden: true,
        restricted: false,
      });
    });
    it('0 switches cold messaging off', async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue(
        account({ strangerContactLimit: 0 }),
      );
      await expect(service.quota('u')).resolves.toMatchObject({
        limit: 0,
        remaining: 0,
      });
    });
  });

  describe('rolling window', () => {
    it('reports remaining slots and when the oldest one frees up', async () => {
      const oldest = new Date(Date.now() - 20 * 3600_000);
      prisma.chatThread.findMany.mockResolvedValue(
        Array.from({ length: 5 }, (_, i) => ({
          requestedAt: new Date(oldest.getTime() + i * 60_000),
        })),
      );
      const q = await service.quota('u');
      expect(q).toMatchObject({ used: 5, remaining: 0 });
      expect(q.resetAt!.getTime()).toBe(oldest.getTime() + QUOTA_WINDOW_MS);
    });
    it('has no reset time while slots remain', async () => {
      prisma.chatThread.findMany.mockResolvedValue([
        { requestedAt: new Date() },
      ]);
      await expect(service.quota('u')).resolves.toMatchObject({
        used: 1,
        remaining: 4,
        resetAt: null,
      });
    });
  });

  describe('claimSlot', () => {
    it('takes the per-user advisory lock and stamps the thread', async () => {
      prisma.chatThread.findUniqueOrThrow.mockResolvedValue({
        requestedAt: null,
      });
      await expect(service.claimSlot('u', 't')).resolves.toBe(true);
      expect(prisma.$executeRaw).toHaveBeenCalled();
      expect(prisma.chatThread.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 't' },
          data: { requestedAt: expect.any(Date) },
        }),
      );
    });
    it('does not charge a thread twice', async () => {
      prisma.chatThread.findUniqueOrThrow.mockResolvedValue({
        requestedAt: new Date(),
      });
      await expect(service.claimSlot('u', 't')).resolves.toBe(false);
      expect(prisma.chatThread.update).not.toHaveBeenCalled();
    });
    it('refuses with a machine-readable code once the cap is used', async () => {
      prisma.chatThread.findUniqueOrThrow.mockResolvedValue({
        requestedAt: null,
      });
      prisma.chatThread.findMany.mockResolvedValue(
        Array.from({ length: 5 }, () => ({ requestedAt: new Date() })),
      );
      await expect(service.claimSlot('u', 't')).rejects.toMatchObject({
        response: { code: 'CONTACT_LIMIT_REACHED', limit: 5 },
      });
      expect(prisma.chatThread.update).not.toHaveBeenCalled();
    });
    it('uses the restricted code when the account is auto-restricted', async () => {
      prisma.chatThread.findUniqueOrThrow.mockResolvedValue({
        requestedAt: null,
      });
      prisma.userBlock.findMany.mockResolvedValue([
        { blockerId: 'a' },
        { blockerId: 'b' },
      ]);
      await expect(service.claimSlot('u', 't')).rejects.toMatchObject({
        response: { code: 'CONTACT_RESTRICTED' },
      });
    });
  });

  describe('isKnown', () => {
    it('is false for total strangers', async () => {
      await expect(service.isKnown('a', 'b')).resolves.toBe(false);
    });
    it.each(['friendship', 'teamMember', 'matchPost'])(
      'is true through %s',
      async (model) => {
        prisma[model].findFirst.mockResolvedValue({ id: 'x' });
        await expect(service.isKnown('a', 'b')).resolves.toBe(true);
      },
    );
  });

  describe('abuse guards', () => {
    it('stops bursts above the per-minute ceiling', async () => {
      prisma.chatMessage.count.mockResolvedValue(30);
      await expect(service.assertNotBursting('u')).rejects.toMatchObject({
        response: { code: 'MESSAGE_RATE_LIMITED' },
      });
      prisma.chatMessage.count.mockResolvedValue(29);
      await expect(service.assertNotBursting('u')).resolves.toBeUndefined();
    });
    it('blocks the same cold text going to a third person', async () => {
      prisma.chatMessage.findMany.mockResolvedValue([
        { text: 'Wanna play?', threadId: 'a' },
        { text: 'wanna  play!!', threadId: 'b' },
        { text: 'something else', threadId: 'c' },
      ]);
      await expect(
        service.assertNotMassMessaging('u', 't', 'wanna play'),
      ).rejects.toMatchObject({
        response: { code: 'MESSAGE_REQUEST_DUPLICATE' },
      });
    });
    it('allows the same text to a second person', async () => {
      prisma.chatMessage.findMany.mockResolvedValue([
        { text: 'Wanna play?', threadId: 'a' },
      ]);
      await expect(
        service.assertNotMassMessaging('u', 't', 'wanna play'),
      ).resolves.toBeUndefined();
    });
  });
});
