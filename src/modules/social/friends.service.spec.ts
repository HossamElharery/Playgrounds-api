import { FriendsService } from './friends.service';
import { PrismaService } from '../prisma/prisma.service';
import { PresenceService } from '../presence/presence.service';
import { RealtimeGatewayEmitter } from '../realtime/realtime-emitter.interface';
import { NotificationsService } from '../notifications/notifications.service';

describe('FriendsService relationship lifecycle', () => {
  const prisma = {
    $transaction: jest.fn(),
    $executeRaw: jest.fn(),
    user: { findUnique: jest.fn() },
    userBlock: { findFirst: jest.fn() },
    friendship: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      create: jest.fn(),
      findUnique: jest.fn(), findUniqueOrThrow: jest.fn(), updateMany: jest.fn(), deleteMany: jest.fn(), delete: jest.fn(),
    },
  };
  const emitter = { emitToUser: jest.fn(), emitToRoom: jest.fn() };
  const notifications = { create: jest.fn() };
  let service: FriendsService;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.$transaction.mockImplementation((action: (tx: unknown) => unknown) => action(prisma));
    prisma.user.findUnique.mockResolvedValue({ status: 'active' });
    prisma.friendship.findFirst.mockResolvedValue(null);
    notifications.create.mockResolvedValue(null);
    prisma.userBlock.findFirst.mockResolvedValue(null);
    service = new FriendsService(
      prisma as unknown as PrismaService,
      {} as PresenceService,
      emitter as unknown as RealtimeGatewayEmitter,
      notifications as unknown as NotificationsService,
    );
  });

  it('reopens a declined request and notifies the recipient again', async () => {
    prisma.friendship.findFirst.mockResolvedValue({
      id: 'request-1',
      status: 'declined',
    });
    prisma.friendship.create.mockResolvedValue({
      id: 'request-2',
      requesterId: 'sender',
      addresseeId: 'recipient',
      status: 'pending',
      requester: { id: 'sender', name: 'Sender', avatarUrl: null },
      addressee: { id: 'recipient', name: 'Recipient', avatarUrl: null },
    });

    const result = await service.sendRequest('sender', 'recipient');

    expect(result.status).toBe('pending');
    expect(emitter.emitToUser).toHaveBeenCalledWith(
      'recipient',
      expect.objectContaining({ type: 'friend.request.created' }),
    );
    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'recipient',
        deepLink: '/app/profile/sender',
        payload: { requestId: 'request-2', requesterId: 'sender', kind: 'friend.request' },
      }),
    );
    expect(prisma.friendship.delete).toHaveBeenCalledWith({ where: { id: 'request-1' } });
    expect(prisma.friendship.update).not.toHaveBeenCalled();
  });

  it('can return both incoming and outgoing pending requests', async () => {
    prisma.friendship.findMany.mockResolvedValue([]);

    await service.listRequests('me', 'all');

    expect(prisma.friendship.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: 'pending',
          OR: [{ requesterId: 'me' }, { addresseeId: 'me' }],
        },
      }),
    );
  });

  it('never auto-accepts an incoming or outgoing pending request', async () => {
    prisma.friendship.findFirst.mockResolvedValue({ id: 'r', status: 'pending', requesterId: 'recipient', addresseeId: 'sender' });
    await expect(service.sendRequest('sender', 'recipient')).rejects.toThrow('Request already pending');
    expect(prisma.friendship.create).not.toHaveBeenCalled();
    expect(prisma.friendship.update).not.toHaveBeenCalled();
  });

  it('rejects self-friending, blocked users and inactive recipients', async () => {
    await expect(service.sendRequest('sender', 'sender')).rejects.toThrow('Cannot friend yourself');
    prisma.userBlock.findFirst.mockResolvedValue({ id: 'block' });
    await expect(service.sendRequest('sender', 'recipient')).rejects.toThrow('Cannot send');
    prisma.userBlock.findFirst.mockResolvedValue(null);
    prisma.user.findUnique.mockResolvedValue({ status: 'suspended' });
    await expect(service.sendRequest('sender', 'recipient')).rejects.toThrow('Player not found');
  });

  it('does not allow the sender or a third party to accept a request', async () => {
    prisma.friendship.findUnique.mockResolvedValue({ id: 'r', requesterId: 'sender', addresseeId: 'recipient', status: 'pending' });
    await expect(service.respond('sender', 'r', true)).rejects.toThrow('Not your request');
    await expect(service.respond('stranger', 'r', true)).rejects.toThrow('Not your request');
    expect(prisma.friendship.updateMany).not.toHaveBeenCalled();
  });

  it('rejects a response when cancellation wins the race', async () => {
    prisma.friendship.findUnique.mockResolvedValue({ id: 'r', requesterId: 'sender', addresseeId: 'recipient', status: 'pending' });
    prisma.friendship.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.respond('recipient', 'r', true)).rejects.toThrow('Request already resolved');
    expect(emitter.emitToUser).not.toHaveBeenCalled();
  });

  it('sends acceptance updates to both accounts only after the recipient accepts', async () => {
    prisma.friendship.findUnique.mockResolvedValue({ id: 'r', requesterId: 'sender', addresseeId: 'recipient', status: 'pending', addressee: { name: 'Recipient' } });
    prisma.friendship.updateMany.mockResolvedValue({ count: 1 });
    prisma.friendship.findUniqueOrThrow.mockResolvedValue({ status: 'accepted' });
    await service.respond('recipient', 'r', true);
    for (const id of ['sender', 'recipient']) expect(emitter.emitToUser).toHaveBeenCalledWith(id, expect.objectContaining({ status: 'accepted' }));
  });

  it('cannot cancel an already accepted request, even if it changed after reading', async () => {
    prisma.friendship.findUnique.mockResolvedValue({ id: 'r', requesterId: 'sender', addresseeId: 'recipient', status: 'pending' });
    prisma.friendship.deleteMany.mockResolvedValue({ count: 0 });
    await expect(service.cancel('sender', 'r')).rejects.toThrow('Request already resolved');
  });

  it('notifies both accounts when a friendship is removed', async () => {
    prisma.friendship.deleteMany.mockResolvedValue({ count: 1 });
    await service.unfriend('sender', 'recipient');
    for (const id of ['sender', 'recipient']) expect(emitter.emitToUser).toHaveBeenCalledWith(id, expect.objectContaining({ type: 'friend.removed' }));
  });
});
