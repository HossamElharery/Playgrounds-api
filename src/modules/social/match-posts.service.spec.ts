import { MatchPostsService } from './match-posts.service';

describe('Match lifecycle regressions', () => {
  const prisma = {
    $transaction: jest.fn(), $executeRaw: jest.fn(),
    matchPost: { findUnique: jest.fn(), updateMany: jest.fn() },
    matchPostJoinRequest: { findUnique: jest.fn(), create: jest.fn(), updateMany: jest.fn() },
    user: { updateMany: jest.fn() },
  };
  let service: MatchPostsService;
  beforeEach(() => {
    jest.resetAllMocks();
    prisma.$transaction.mockImplementation(fn => fn(prisma));
    prisma.matchPost.findUnique.mockResolvedValue({ id: 'match', authorId: 'captain', status: 'open', joinRequests: [{ userId: 'member' }] });
    service = new MatchPostsService(prisma as never, {} as never, {} as never);
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
