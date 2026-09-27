import { SquadService } from './squad.service';

describe('Guest lifecycle and promotion', () => {
  let service: SquadService;
  let prisma: any;
  let tx: any;
  let emitter: any;
  beforeEach(() => {
    tx = {
      $queryRaw: jest.fn(),
      user: { findFirst: jest.fn(), delete: jest.fn() },
      friendship: { deleteMany: jest.fn() },
    };
    prisma = {
      user: { findMany: jest.fn().mockResolvedValue([{ id: 'g1' }]) },
      squadInviteLink: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      squadMember: { findFirst: jest.fn() },
      $transaction: jest.fn(async (fn) => fn(tx)),
    };
    emitter = { emitToRoom: jest.fn() };
    service = Object.create(SquadService.prototype);
    Object.assign(service, { prisma, emitter });
  });

  it('does not delete a promoted or recently active guest found in a stale sweep snapshot', async () => {
    tx.user.findFirst.mockResolvedValue(null);
    await service.sweepGuests();
    expect(tx.$queryRaw).toHaveBeenCalled();
    expect(tx.friendship.deleteMany).not.toHaveBeenCalled();
    expect(tx.user.delete).not.toHaveBeenCalled();
    expect(tx.user.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ isGuest: true, createdAt: expect.any(Object), squadMemberships: { none: {} } }) }));
  });

  it('removes only an identity that is still an idle guest under the promotion lock', async () => {
    tx.user.findFirst.mockResolvedValue({ id: 'g1', isGuest: true });
    await service.sweepGuests();
    expect(tx.friendship.deleteMany).toHaveBeenCalled();
    expect(tx.user.delete).toHaveBeenCalledWith({ where: { id: 'g1', isGuest: true } });
  });

  it('refreshes squad profiles after promotion without leaving or rejoining', async () => {
    prisma.squadMember.findFirst.mockResolvedValue({ squadId: 's1' });
    await service.accountCompleted('g1');
    expect(emitter.emitToRoom).toHaveBeenCalledWith('squad:s1', { type: 'squad.member.updated', squadId: 's1', userId: 'g1' });
  });
});
