import { MatchPostsService } from './match-posts.service';

describe('Match lifecycle regressions', () => {
  const prisma = {
    $transaction: jest.fn(), $executeRaw: jest.fn(),
    matchPost: { findUnique: jest.fn(), updateMany: jest.fn(), findMany: jest.fn() },
    matchPostJoinRequest: { findUnique: jest.fn(), create: jest.fn(), updateMany: jest.fn(), deleteMany: jest.fn() },
    chatThreadParticipant: { deleteMany: jest.fn() },
    user: { updateMany: jest.fn() },
  };
  const notifications = { create: jest.fn().mockResolvedValue(null) };
  let service: MatchPostsService;
  beforeEach(() => {
    jest.resetAllMocks();
    prisma.$transaction.mockImplementation(fn => fn(prisma));
    prisma.matchPost.findUnique.mockResolvedValue({ id: 'match', authorId: 'captain', status: 'open', dateTime: new Date(Date.now() + 86_400_000), joinRequests: [{ userId: 'member' }] });
    notifications.create.mockResolvedValue(null);
    service = new MatchPostsService(prisma as never, {} as never, notifications as never);
    jest.spyOn(service, 'getById').mockResolvedValue({} as never);
  });
  it('tells the feed list whether the viewer already requested, is approved, or organizes each post', async () => {
    prisma.matchPost.findMany.mockResolvedValue([
      { id: 'm1', authorId: 'captain', _count: { comments: 0, reactions: 0 }, joinRequests: [{ userId: 'member', status: 'pending', user: { id: 'member', name: 'M', avatarUrl: null } }] },
      { id: 'm2', authorId: 'someoneElse', _count: { comments: 0, reactions: 0 }, joinRequests: [] },
    ]);
    const result = await service.feed({}, 'member');
    expect(result[0].viewerJoinStatus).toBe('pending');
    expect(result[1].viewerJoinStatus).toBe('none');
  });

  it('marks a post organizer regardless of any join request row', async () => {
    prisma.matchPost.findMany.mockResolvedValue([
      { id: 'm1', authorId: 'captain', _count: { comments: 0, reactions: 0 }, joinRequests: [] },
    ]);
    const result = await service.feed({}, 'captain');
    expect(result[0].viewerJoinStatus).toBe('organizer');
  });

  it('tells the organizer when an approved player drops out', async () => {
    prisma.matchPostJoinRequest.findUnique.mockResolvedValue({ status: 'approved', user: { name: 'Sam' } });
    await service.leave('member', 'match');
    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'captain', category: 'matches' }),
    );
  });

  it('says nothing when a merely-pending request is withdrawn', async () => {
    prisma.matchPostJoinRequest.findUnique.mockResolvedValue({ status: 'pending', user: { name: 'Sam' } });
    await service.leave('member', 'match');
    expect(notifications.create).not.toHaveBeenCalled();
  });

  it('refuses to join a match that has already kicked off', async () => {
    prisma.matchPost.findUnique.mockResolvedValue({ id: 'match', authorId: 'captain', status: 'open', dateTime: new Date(Date.now() - 3_600_000), joinRequests: [] });
    await expect(service.requestJoin('member', 'match')).rejects.toThrow('already started');
    expect(prisma.matchPostJoinRequest.create).not.toHaveBeenCalled();
  });
  it('does not downgrade an accepted membership when joining again', async () => {
    prisma.matchPostJoinRequest.findUnique.mockResolvedValue({ id: 'request', status: 'approved' });
    await expect(service.requestJoin('member', 'match')).rejects.toThrow('Already a match member');
    expect(prisma.matchPostJoinRequest.updateMany).not.toHaveBeenCalled();
    expect(prisma.matchPostJoinRequest.create).not.toHaveBeenCalled();
  });
  it('does not duplicate a pending request', async () => {
    prisma.matchPostJoinRequest.findUnique.mockResolvedValue({ id: 'request', status: 'pending' });
    await expect(service.requestJoin('member', 'match')).rejects.toThrow('already pending');
    expect(prisma.matchPostJoinRequest.create).not.toHaveBeenCalled();
  });
  it('increments player statistics only for the first successful completion', async () => {
    prisma.matchPost.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    await service.markPlayed('captain', 'match');
    prisma.matchPost.findUnique.mockResolvedValue({ id: 'match', authorId: 'captain', status: 'played', joinRequests: [] });
    await service.markPlayed('captain', 'match');
    expect(prisma.user.updateMany).toHaveBeenCalledTimes(1);
  });
  it('cannot complete a cancelled match', async () => {
    prisma.matchPost.findUnique.mockResolvedValue({ id: 'match', authorId: 'captain', status: 'cancelled', joinRequests: [] });
    prisma.matchPost.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.markPlayed('captain', 'match')).rejects.toThrow('already closed');
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });
});
