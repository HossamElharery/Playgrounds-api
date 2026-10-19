/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any, @typescript-eslint/unbound-method */
import { ChatService } from './chat.service';

describe('Existing direct-chat privacy', () => {
  const prisma = {
    chatThreadParticipant: { findUnique: jest.fn() },
    chatThread: { findUniqueOrThrow: jest.fn(), findUnique: jest.fn() },
    userBlock: { findFirst: jest.fn() },
    user: { findUnique: jest.fn() },
    friendship: { findFirst: jest.fn() },
    follow: { findUnique: jest.fn() },
    teamMember: { findFirst: jest.fn() },
    chatMessage: {
      findUnique: jest.fn(),
      create: jest.fn(),
      findMany: jest.fn(),
    },
  };
  const trust = {
    isKnown: jest.fn(),
    quota: jest.fn(),
    assertNotBursting: jest.fn(),
  };
  const service = new ChatService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    trust as never,
  );
  beforeEach(() => {
    jest.resetAllMocks();
    prisma.chatThreadParticipant.findUnique.mockResolvedValue({});
    prisma.chatThread.findUniqueOrThrow.mockResolvedValue({
      type: 'direct',
      requestState: 'none',
      participants: [{ userId: 'me' }, { userId: 'other' }],
    });
    prisma.userBlock.findFirst.mockResolvedValue(null);
    prisma.user.findUnique.mockResolvedValue({
      status: 'active',
      messagePolicy: 'everyone',
    });
    prisma.chatThread.findUnique.mockResolvedValue(null);
    trust.isKnown.mockResolvedValue(true);
  });
  const send = () =>
    service.sendMessage('me', 'old-thread', {
      type: 'text',
      text: 'Hello',
      clientMessageId: 'message',
    } as never);
  it('blocks sending into a pre-existing thread after either player blocks the other', async () => {
    prisma.userBlock.findFirst.mockResolvedValue({ id: 'block' });
    await expect(send()).rejects.toThrow('Cannot message');
    expect(prisma.chatMessage.create).not.toHaveBeenCalled();
  });
  it('honors a friends-only policy after unfriending', async () => {
    prisma.user.findUnique.mockResolvedValue({
      status: 'active',
      messagePolicy: 'friends',
    });
    prisma.friendship.findFirst.mockResolvedValue(null);
    await expect(send()).rejects.toThrow('Only friends');
    expect(prisma.chatMessage.create).not.toHaveBeenCalled();
  });
  it('does not treat another sender’s message ID as this sender’s successful message', async () => {
    prisma.chatMessage.findUnique.mockResolvedValue({ senderId: 'other' });
    await expect(send()).rejects.toThrow('Message ID already used');
  });
  it('denies former team members before reading or writing messages', async () => {
    prisma.chatThreadParticipant.findUnique.mockResolvedValue(null);
    await expect(send()).rejects.toThrow('Not a participant');
    expect(prisma.chatMessage.create).not.toHaveBeenCalled();
  });
  it('reads messages by timestamp rather than random UUID order', async () => {
    prisma.chatMessage.findMany.mockResolvedValue([]);
    await service.listMessages('me', 'old-thread');
    expect(prisma.chatMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
    );
  });
  describe('recipient privacy policy', () => {
    const policy = (messagePolicy: string) =>
      prisma.user.findUnique.mockResolvedValue({
        status: 'active',
        messagePolicy,
      });

    it('defaults to everyone: a stranger can message without any friend request', async () => {
      policy('everyone');
      await expect(service.messageAccess('me', 'other')).resolves.toMatchObject(
        { allowed: true, restriction: null },
      );
      expect(prisma.friendship.findFirst).not.toHaveBeenCalled();
    });
    it('treats an unknown stored value as everyone', async () => {
      policy('legacy-garbage');
      await expect(service.messageAccess('me', 'other')).resolves.toMatchObject(
        { allowed: true, policy: 'everyone' },
      );
    });
    it('nobody blocks everyone, even friends', async () => {
      policy('nobody');
      await expect(service.messageAccess('me', 'other')).resolves.toMatchObject(
        { allowed: false, restriction: 'MESSAGES_CLOSED' },
      );
    });
    it('friends accepts friends and rejects followers', async () => {
      policy('friends');
      prisma.friendship.findFirst.mockResolvedValueOnce({ id: 'f' });
      await expect(service.messageAccess('me', 'other')).resolves.toMatchObject(
        { allowed: true, isFriend: true },
      );
      prisma.friendship.findFirst.mockResolvedValueOnce(null);
      await expect(service.messageAccess('me', 'other')).resolves.toMatchObject(
        { allowed: false, restriction: 'MESSAGES_FRIENDS_ONLY' },
      );
    });
    it('followers accepts friends and people who follow the recipient, rejects strangers', async () => {
      policy('followers');
      prisma.friendship.findFirst.mockResolvedValue(null);
      prisma.follow.findUnique.mockResolvedValueOnce({ followerId: 'me' });
      await expect(service.messageAccess('me', 'other')).resolves.toMatchObject(
        { allowed: true, isFollowing: true },
      );
      expect(prisma.follow.findUnique).toHaveBeenCalledWith({
        where: {
          followerId_followingId: { followerId: 'me', followingId: 'other' },
        },
      });
      prisma.follow.findUnique.mockResolvedValueOnce(null);
      await expect(service.messageAccess('me', 'other')).resolves.toMatchObject(
        { allowed: false, restriction: 'MESSAGES_FOLLOWERS_ONLY' },
      );
      prisma.friendship.findFirst.mockResolvedValueOnce({ id: 'f' });
      prisma.follow.findUnique.mockResolvedValueOnce(null);
      await expect(service.messageAccess('me', 'other')).resolves.toMatchObject(
        { allowed: true, isFriend: true },
      );
    });
    it('teammates accepts a shared team', async () => {
      policy('teammates');
      prisma.friendship.findFirst.mockResolvedValue(null);
      prisma.teamMember.findFirst.mockResolvedValueOnce({ id: 't' });
      await expect(service.messageAccess('me', 'other')).resolves.toMatchObject(
        { allowed: true },
      );
      prisma.teamMember.findFirst.mockResolvedValueOnce(null);
      await expect(service.messageAccess('me', 'other')).resolves.toMatchObject(
        { allowed: false, restriction: 'MESSAGES_TEAMMATES_ONLY' },
      );
    });
    it('a block wins over any policy and is not disclosed as a privacy choice', async () => {
      policy('everyone');
      prisma.userBlock.findFirst.mockResolvedValue({ id: 'b' });
      await expect(
        service.getMessageAccess('me', 'other'),
      ).resolves.toMatchObject({
        canMessage: false,
        restriction: 'MESSAGES_BLOCKED',
        policy: 'everyone',
      });
    });
    it('rejects deleted, suspended or guest recipients', async () => {
      prisma.user.findUnique.mockResolvedValue({
        status: 'suspended',
        messagePolicy: 'everyone',
      });
      await expect(service.messageAccess('me', 'other')).rejects.toThrow(
        'Player not found',
      );
    });
    it('a send fails with a machine-readable code when the policy was tightened', async () => {
      policy('followers');
      prisma.friendship.findFirst.mockResolvedValue(null);
      prisma.follow.findUnique.mockResolvedValue(null);
      await expect(send()).rejects.toMatchObject({
        response: { code: 'MESSAGES_FOLLOWERS_ONLY' },
      });
    });
  });
});
