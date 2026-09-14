import { TeamsService } from './teams.service';

describe('Team membership and captaincy', () => {
  const team = { id: 'team', captainId: 'captain', chatThreadId: 'chat', archivedAt: null };
  const prisma = {
    $transaction: jest.fn(), $executeRaw: jest.fn(),
    team: { findUnique: jest.fn(), update: jest.fn() },
    teamMember: { findMany: jest.fn(), findUnique: jest.fn(), deleteMany: jest.fn(), upsert: jest.fn() },
    teamMembershipRequest: { findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn(), create: jest.fn() },
    chatThreadParticipant: { deleteMany: jest.fn(), upsert: jest.fn() },
    user: { findFirst: jest.fn() }, userBlock: { findFirst: jest.fn() },
  };
  const emitter = { emitToUser: jest.fn(), revokeRoomAccess: jest.fn() };
  const notifications = { create: jest.fn() };
  let service: TeamsService;
  beforeEach(() => {
    jest.resetAllMocks();
    prisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(prisma));
    prisma.team.findUnique.mockResolvedValue(team);
    prisma.teamMember.findMany.mockResolvedValue([{ userId: 'captain' }]);
    prisma.user.findFirst.mockResolvedValue({ id: 'member', status: 'active' });
    notifications.create.mockResolvedValue(null);
    service = new TeamsService(prisma as never, emitter as never, notifications as never);
  });
  it('lets a member leave and revokes team chat access', async () => {
    await service.removeMember('member', 'team', 'member');
    expect(prisma.teamMember.deleteMany).toHaveBeenCalledWith({ where: { teamId: 'team', userId: 'member' } });
    expect(prisma.chatThreadParticipant.deleteMany).toHaveBeenCalledWith({ where: { threadId: 'chat', userId: 'member' } });
    expect(emitter.emitToUser).toHaveBeenCalledWith('member', { type: 'team.changed', teamId: 'team' });
  });
  it('prevents a member from removing another member', async () => {
    await expect(service.removeMember('stranger', 'team', 'member')).rejects.toThrow('Only the captain');
    expect(prisma.teamMember.deleteMany).not.toHaveBeenCalled();
  });
  it('requires transfer or archival before the captain leaves', async () => {
    await expect(service.removeMember('captain', 'team', 'captain')).rejects.toThrow('Transfer captaincy');
    expect(prisma.teamMember.deleteMany).not.toHaveBeenCalled();
  });
  it('only transfers leadership to an existing member', async () => {
    prisma.teamMember.findUnique.mockResolvedValue(null);
    await expect(service.transferCaptain('captain', 'team', 'stranger')).rejects.toThrow('must be a team member');
    prisma.teamMember.findUnique.mockResolvedValue({ userId: 'member' });
    await service.transferCaptain('captain', 'team', 'member');
    expect(prisma.team.update).toHaveBeenCalledWith({ where: { id: 'team' }, data: { captainId: 'member' } });
  });
  it('does not allow the captain to silently add someone without acceptance', async () => {
    prisma.teamMembershipRequest.create.mockResolvedValue({ id: 'invite', team: { ...team, name: 'Team' }, user: { name: 'Member' } });
    await service.addMember('captain', 'team', 'member');
    expect(prisma.teamMember.upsert).not.toHaveBeenCalled();
    expect(prisma.teamMembershipRequest.create).toHaveBeenCalled();
  });
  it('only the invited player may accept their invitation', async () => {
    prisma.teamMembershipRequest.findUnique.mockResolvedValue({ id: 'invite', teamId: 'team', userId: 'member', requestedById: 'captain', status: 'pending' });
    await expect(service.resolveRequest('captain', 'invite', 'accept')).rejects.toThrow('Not your request');
    await service.resolveRequest('member', 'invite', 'accept');
    expect(prisma.teamMember.upsert).toHaveBeenCalled();
    expect(prisma.chatThreadParticipant.upsert).toHaveBeenCalled();
  });
  it('only the captain may accept a player’s join request', async () => {
    prisma.teamMembershipRequest.findUnique.mockResolvedValue({ id: 'request', teamId: 'team', userId: 'member', requestedById: 'member', status: 'pending' });
    await expect(service.resolveRequest('member', 'request', 'accept')).rejects.toThrow('Not your request');
    await service.resolveRequest('captain', 'request', 'accept');
    expect(prisma.teamMember.upsert).toHaveBeenCalled();
  });
  it('cannot accept a request that was cancelled or a team that was archived', async () => {
    prisma.teamMembershipRequest.findUnique.mockResolvedValue({ id: 'r', teamId: 'team', status: 'cancelled' });
    await expect(service.resolveRequest('member', 'r', 'accept')).rejects.toThrow('Request already resolved');
    prisma.team.findUnique.mockResolvedValue({ ...team, archivedAt: new Date() });
    await expect(service.removeMember('member', 'team', 'member')).rejects.toThrow('Team not found');
  });
  it('does not approve a join request from a deactivated player', async () => {
    prisma.teamMembershipRequest.findUnique.mockResolvedValue({ id: 'request', teamId: 'team', userId: 'member', requestedById: 'member', status: 'pending' });
    prisma.user.findFirst.mockResolvedValue(null);
    await expect(service.resolveRequest('captain', 'request', 'accept')).rejects.toThrow('no longer active');
    expect(prisma.teamMember.upsert).not.toHaveBeenCalled();
  });
});
