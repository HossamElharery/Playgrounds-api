import { ChatService } from './chat.service';

describe('Existing direct-chat privacy', () => {
  const prisma = {
    chatThreadParticipant: { findUnique: jest.fn() },
    chatThread: { findUniqueOrThrow: jest.fn() },
    userBlock: { findFirst: jest.fn() },
    user: { findUnique: jest.fn() },
    friendship: { findFirst: jest.fn() },
    chatMessage: { findUnique: jest.fn(), create: jest.fn() },
  };
  const service = new ChatService(prisma as never, {} as never, {} as never, {} as never);
  beforeEach(() => {
    jest.resetAllMocks();
    prisma.chatThreadParticipant.findUnique.mockResolvedValue({});
    prisma.chatThread.findUniqueOrThrow.mockResolvedValue({ type: 'direct', participants: [{ userId: 'me' }, { userId: 'other' }] });
    prisma.userBlock.findFirst.mockResolvedValue(null);
    prisma.user.findUnique.mockResolvedValue({ status: 'active', messagePolicy: 'everyone' });
  });
  const send = () => service.sendMessage('me', 'old-thread', { type: 'text', text: 'Hello', clientMessageId: 'message' } as never);
  it('blocks sending into a pre-existing thread after either player blocks the other', async () => {
    prisma.userBlock.findFirst.mockResolvedValue({ id: 'block' });
    await expect(send()).rejects.toThrow('Cannot message');
    expect(prisma.chatMessage.create).not.toHaveBeenCalled();
  });
  it('honors a friends-only policy after unfriending', async () => {
    prisma.user.findUnique.mockResolvedValue({ status: 'active', messagePolicy: 'friends' });
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
});
