/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any, @typescript-eslint/unbound-method */
import { ChatService } from './chat.service';

describe('Cold-contact message requests', () => {
  const prisma: any = {
    chatThreadParticipant: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
    },
    chatThread: {
      findUniqueOrThrow: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    userBlock: { findFirst: jest.fn() },
    user: { findUnique: jest.fn() },
    friendship: { findFirst: jest.fn() },
    chatMessage: { findUnique: jest.fn(), create: jest.fn(), count: jest.fn() },
  };
  const emitter = { emitToRoom: jest.fn(), emitToUser: jest.fn() };
  const notifications = { create: jest.fn() };
  const trust = {
    isKnown: jest.fn(),
    quota: jest.fn(),
    limitReached: jest.fn(),
    claimSlot: jest.fn(),
    releaseSlot: jest.fn(),
    assertNotBursting: jest.fn(),
    assertNotMassMessaging: jest.fn(),
  };
  const service = new ChatService(
    prisma,
    {} as never,
    emitter as never,
    notifications as never,
    trust as never,
  );

  const thread = (over: Record<string, unknown> = {}) => ({
    id: 't1',
    type: 'direct',
    requestState: 'pending',
    requestedById: 'me',
    participants: [{ userId: 'me' }, { userId: 'other' }],
    ...over,
  });
  const send = (
    text = 'يلا نلعب؟',
    as = 'me',
    extra: Record<string, unknown> = {},
  ) =>
    service.sendMessage(as, 't1', {
      type: 'text',
      text,
      clientMessageId: `c-${Math.random()}`,
      ...extra,
    } as never);

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.chatThreadParticipant.findUnique.mockResolvedValue({});
    prisma.chatThreadParticipant.findMany.mockResolvedValue([
      { userId: 'other', user: { name: 'O' } },
    ]);
    prisma.chatThread.findUniqueOrThrow.mockResolvedValue(thread());
    prisma.userBlock.findFirst.mockResolvedValue(null);
    prisma.user.findUnique.mockResolvedValue({
      status: 'active',
      messagePolicy: 'everyone',
    });
    prisma.chatMessage.findUnique.mockResolvedValue(null);
    prisma.chatMessage.count.mockResolvedValue(0);
    prisma.chatMessage.create.mockImplementation(async ({ data }: any) => ({
      id: 'm1',
      ...data,
      delivery: 'sent',
      createdAt: new Date(),
      editedAt: null,
      deletedAt: null,
      sender: { id: data.senderId, name: 'Me', avatarUrl: null },
    }));
    trust.isKnown.mockResolvedValue(false);
    trust.claimSlot.mockResolvedValue(true);
    trust.releaseSlot.mockResolvedValue(undefined);
    trust.assertNotBursting.mockResolvedValue(undefined);
    trust.assertNotMassMessaging.mockResolvedValue(undefined);
    trust.quota.mockResolvedValue({
      remaining: 3,
      limit: 5,
      used: 2,
      resetAt: null,
      restricted: false,
      tier: 'standard',
    });
    trust.limitReached.mockImplementation((q: any) =>
      Object.assign(new Error('limit'), {
        response: { code: 'CONTACT_LIMIT_REACHED', limit: q.limit },
      }),
    );
  });

  describe('opening a chat with a stranger', () => {
    const open = () => service.findOrCreateDirectThread('me', 'other');
    beforeEach(() => {
      prisma.chatThread.findUnique.mockResolvedValue(null);
      prisma.chatThread.create.mockResolvedValue({ id: 't1' });
      prisma.chatThread.findUniqueOrThrow.mockResolvedValue({
        ...thread(),
        title: null,
        participants: [],
        messages: [],
        matchPost: null,
        team: null,
        updatedAt: new Date(),
      });
      prisma.chatMessage.count.mockResolvedValue(0);
    });
    it('creates a pending request owned by the sender and keeps it invisible to the recipient', async () => {
      await open();
      expect(prisma.chatThread.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            requestState: 'pending',
            requestedById: 'me',
          }),
        }),
      );
      expect(emitter.emitToUser).not.toHaveBeenCalled();
    });
    it('refuses before creating anything once the daily cap is spent', async () => {
      trust.quota.mockResolvedValue({
        remaining: 0,
        limit: 5,
        used: 5,
        resetAt: new Date(),
        restricted: false,
      });
      await expect(open()).rejects.toMatchObject({
        response: { code: 'CONTACT_LIMIT_REACHED' },
      });
      expect(prisma.chatThread.create).not.toHaveBeenCalled();
    });
    it('does not spend or check the cap for people who already know each other', async () => {
      trust.isKnown.mockResolvedValue(true);
      await open();
      expect(trust.quota).not.toHaveBeenCalled();
      expect(prisma.chatThread.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            requestState: 'none',
            requestedById: null,
          }),
        }),
      );
      expect(emitter.emitToUser).toHaveBeenCalled();
    });
    it('still reopens an existing chat after the cap is spent', async () => {
      prisma.chatThread.findUnique.mockResolvedValue({ id: 't1' });
      trust.quota.mockResolvedValue({ remaining: 0 });
      await expect(open()).resolves.toMatchObject({ created: false });
    });
    it('recovers from a double-tap race on the unique pair', async () => {
      const { Prisma } = jest.requireActual('@prisma/client');
      prisma.chatThread.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('dup', {
          code: 'P2002',
          clientVersion: 't',
        }),
      );
      prisma.chatThread.findUniqueOrThrow.mockResolvedValue({
        ...thread(),
        title: null,
        participants: [],
        messages: [],
        matchPost: null,
        team: null,
        updatedAt: new Date(),
      });
      await expect(open()).resolves.toMatchObject({ created: false });
    });
  });

  describe('the stranger’s first message', () => {
    it('is delivered silently: in-app request, never a push', async () => {
      await send();
      expect(trust.claimSlot).toHaveBeenCalledWith('me', 't1');
      expect(notifications.create).toHaveBeenCalledWith(
        expect.objectContaining({
          noPush: true,
          titleEn: 'New message request',
        }),
      );
    });
    it.each([
      ['a link', 'join http://evil.example', 'MESSAGE_REQUEST_NO_LINKS'],
      [
        'a phone number',
        'whatsapp 01012345678',
        'MESSAGE_REQUEST_NO_CONTACT_INFO',
      ],
      ['too much text', 'x'.repeat(301), 'MESSAGE_REQUEST_TOO_LONG'],
    ])('is rejected for %s without spending a slot', async (_n, text, code) => {
      await expect(send(text)).rejects.toMatchObject({ response: { code } });
      expect(trust.claimSlot).not.toHaveBeenCalled();
      expect(prisma.chatMessage.create).not.toHaveBeenCalled();
    });
    it('cannot be an image or voice note', async () => {
      await expect(
        send(undefined, 'me', {
          type: 'image',
          text: undefined,
          attachmentUrl: '/u/a.png',
        }),
      ).rejects.toMatchObject({
        response: { code: 'MESSAGE_REQUEST_TEXT_ONLY' },
      });
    });
    it('hands back the slot when the message fails to save', async () => {
      prisma.chatMessage.create.mockRejectedValue(new Error('db down'));
      await expect(send()).rejects.toThrow('db down');
      expect(trust.releaseSlot).toHaveBeenCalledWith('t1');
    });
    it('does not release a slot it never claimed', async () => {
      trust.claimSlot.mockResolvedValue(false);
      await expect(send()).rejects.toMatchObject({
        response: { code: 'MESSAGES_REQUEST_PENDING' },
      });
      expect(trust.releaseSlot).not.toHaveBeenCalled();
    });
    it('propagates the cap error from the atomic claim', async () => {
      trust.claimSlot.mockRejectedValue(
        Object.assign(new Error('x'), {
          response: { code: 'CONTACT_LIMIT_REACHED' },
        }),
      );
      await expect(send()).rejects.toMatchObject({
        response: { code: 'CONTACT_LIMIT_REACHED' },
      });
      expect(prisma.chatMessage.create).not.toHaveBeenCalled();
    });
    it('is stopped by the mass-message guard', async () => {
      trust.assertNotMassMessaging.mockRejectedValue(
        Object.assign(new Error('x'), {
          response: { code: 'MESSAGE_REQUEST_DUPLICATE' },
        }),
      );
      await expect(send()).rejects.toMatchObject({
        response: { code: 'MESSAGE_REQUEST_DUPLICATE' },
      });
      expect(trust.claimSlot).not.toHaveBeenCalled();
    });
  });

  describe('after the first message', () => {
    it('allows no second message until the recipient replies', async () => {
      prisma.chatMessage.count.mockResolvedValue(1);
      await expect(send('hello again')).rejects.toMatchObject({
        response: { code: 'MESSAGES_REQUEST_PENDING' },
      });
      expect(prisma.chatMessage.create).not.toHaveBeenCalled();
    });
    it('applies equally when the recipient dismissed the request (sender is never told)', async () => {
      prisma.chatThread.findUniqueOrThrow.mockResolvedValue(
        thread({ requestState: 'declined' }),
      );
      prisma.chatMessage.count.mockResolvedValue(1);
      await expect(send()).rejects.toMatchObject({
        response: { code: 'MESSAGES_REQUEST_PENDING' },
      });
    });
    it('the recipient’s reply accepts the request and lifts every limit', async () => {
      await send('أهلا', 'other');
      expect(prisma.chatThread.update).toHaveBeenCalledWith({
        where: { id: 't1' },
        data: { requestState: 'accepted' },
      });
      expect(trust.claimSlot).not.toHaveBeenCalled();
      expect(notifications.create).toHaveBeenCalledWith(
        expect.not.objectContaining({ noPush: true }),
      );
    });
    it('becoming friends / teammates / match-mates accepts it automatically', async () => {
      trust.isKnown.mockResolvedValue(true);
      await send('link ok http://x.example');
      expect(prisma.chatThread.update).toHaveBeenCalledWith({
        where: { id: 't1' },
        data: { requestState: 'accepted' },
      });
    });
    it('imposes nothing on an accepted thread', async () => {
      prisma.chatThread.findUniqueOrThrow.mockResolvedValue(
        thread({ requestState: 'accepted' }),
      );
      prisma.chatMessage.count.mockResolvedValue(9);
      await expect(
        send('see https://maps.example/x 01012345678'),
      ).resolves.toBeDefined();
    });
  });

  describe('respondToRequest', () => {
    const summary = () =>
      prisma.chatThread.findUniqueOrThrow.mockResolvedValue({
        ...thread({ requestedById: 'other' }),
        title: null,
        participants: [],
        messages: [],
        matchPost: null,
        team: null,
        updatedAt: new Date(),
      });
    it('lets only the recipient answer a pending request', async () => {
      prisma.chatThread.findUniqueOrThrow.mockResolvedValue(thread());
      await expect(
        service.respondToRequest('me', 't1', 'accept'),
      ).rejects.toThrow('no pending request');
      expect(prisma.chatThread.update).not.toHaveBeenCalled();
    });
    it('rejects threads that are not pending requests', async () => {
      prisma.chatThread.findUniqueOrThrow.mockResolvedValue(
        thread({ requestedById: 'other', requestState: 'accepted' }),
      );
      await expect(
        service.respondToRequest('me', 't1', 'decline'),
      ).rejects.toThrow('no pending request');
    });
    it('accepts and declines', async () => {
      summary();
      await service
        .respondToRequest('me', 't1', 'decline')
        .catch(() => undefined);
      expect(prisma.chatThread.update).toHaveBeenCalledWith({
        where: { id: 't1' },
        data: { requestState: 'declined' },
      });
      await service
        .respondToRequest('me', 't1', 'accept')
        .catch(() => undefined);
      expect(prisma.chatThread.update).toHaveBeenCalledWith({
        where: { id: 't1' },
        data: { requestState: 'accepted' },
      });
    });
    it('requires membership of the thread', async () => {
      prisma.chatThreadParticipant.findUnique.mockResolvedValue(null);
      await expect(
        service.respondToRequest('x', 't1', 'accept'),
      ).rejects.toThrow('Not a participant');
    });
  });

  describe('editing the one request message', () => {
    const msg = {
      id: 'm1',
      threadId: 't1',
      senderId: 'me',
      type: 'text',
      deletedAt: null,
    };
    it('cannot smuggle a link in after sending', async () => {
      prisma.chatMessage.findUnique.mockResolvedValue(msg);
      await expect(
        service.editMessage('me', 't1', 'm1', 'now click http://evil.example'),
      ).rejects.toMatchObject({
        response: { code: 'MESSAGE_REQUEST_NO_LINKS' },
      });
    });
  });
});
