import { PulseService } from './pulse.service';

describe('Pulse claim gate and confirmation', () => {
  const prisma = {
    pulseOpportunity: { findUnique: jest.fn(), findUniqueOrThrow: jest.fn(), update: jest.fn() },
    pulseClaim: {
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      count: jest.fn(),
    },
    friendship: { findMany: jest.fn() },
    $transaction: jest.fn(),
  };
  const matchPosts = { requestJoin: jest.fn() };
  let service: PulseService;

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(prisma));
    prisma.friendship.findMany.mockResolvedValue([]);
    prisma.pulseClaim.updateMany.mockResolvedValue({ count: 1 });
    prisma.pulseClaim.findUniqueOrThrow.mockResolvedValue({
      id: 'c1', state: 'confirmed', holdExpiresAt: null,
    });
    service = new PulseService(
      prisma as never,
      { emitToUser: jest.fn(), emitToRoom: jest.fn() } as never,
      matchPosts as never,
    );
  });

  it('returns a real opportunity DTO on claim, not the bare claim row mistaken for one', async () => {
    prisma.pulseOpportunity.findUnique.mockResolvedValue({
      id: 'opp-1', matchPostId: null, expiresAt: new Date(Date.now() + 600_000),
      status: 'open', capacity: 4,
    });
    prisma.pulseClaim.count.mockResolvedValue(1);
    const heldExpiry = new Date(Date.now() + 90_000);
    prisma.pulseClaim.create.mockResolvedValue({ id: 'claim-1', holdExpiresAt: heldExpiry, state: 'held' });
    prisma.pulseOpportunity.findUniqueOrThrow.mockResolvedValue({
      id: 'opp-1', matchPostId: 'match-9', kind: 'rescue', status: 'held', sportId: 's1', mode: 'casual',
      skillTier: null, startsAt: new Date(), expiresAt: new Date(), costPerPlayerAmount: 0,
      originalCostPerPlayerAmount: null, currency: 'EGP', capacity: 4, reliabilityFloor: null, urgent: false,
      version: 1, claims: [{ state: 'held', userId: 'u1' }],
    });
    const result = await service.claim('u1', 'opp-1');
    if ('kind' in result) throw new Error('expected a direct claim, not a match_join_request');
    expect(result.holdExpiresAt).toBe(heldExpiry);
    expect(result.opportunity.id).toBe('opp-1');
    expect(result.opportunity.matchId).toBe('match-9');
    expect(result.opportunity.claimedByMe).toBe(true);
  });

  it('routes a claim on a match-backed opportunity through the real join-request gate', async () => {
    prisma.pulseOpportunity.findUnique.mockResolvedValue({ matchPostId: 'match-1' });
    matchPosts.requestJoin.mockResolvedValue({ id: 'req-1', status: 'pending' });
    const result = await service.claim('u1', 'opp-1');
    expect(matchPosts.requestJoin).toHaveBeenCalledWith('u1', 'match-1');
    expect(prisma.pulseClaim.create).not.toHaveBeenCalled();
    expect(result).toEqual({ kind: 'match_join_request', matchPostId: 'match-1', request: { id: 'req-1', status: 'pending' } });
  });

  it('confirms a held claim before its hold expires', async () => {
    prisma.pulseClaim.findUnique.mockResolvedValue({ id: 'c1', state: 'held', holdExpiresAt: new Date(Date.now() + 60_000) });
    await service.confirmClaim('u1', 'opp-1');
    expect(prisma.pulseClaim.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: 'c1', state: 'held' }),
      data: { state: 'confirmed', holdExpiresAt: null },
    });
  });

  it('refuses to confirm a claim whose hold already expired', async () => {
    prisma.pulseClaim.findUnique.mockResolvedValue({ id: 'c1', state: 'held', holdExpiresAt: new Date(Date.now() - 1000) });
    await expect(service.confirmClaim('u1', 'opp-1')).rejects.toThrow('PULSE_HOLD_EXPIRED');
    expect(prisma.pulseClaim.updateMany).not.toHaveBeenCalled();
  });

  it('refuses to confirm a released claim', async () => {
    prisma.pulseClaim.findUnique.mockResolvedValue({ id: 'c1', state: 'released', holdExpiresAt: null });
    await expect(service.confirmClaim('u1', 'opp-1')).rejects.toThrow('no longer active');
  });

  it('is idempotent when the claim is already confirmed', async () => {
    prisma.pulseClaim.findUnique.mockResolvedValue({ id: 'c1', state: 'confirmed', holdExpiresAt: null });
    await service.confirmClaim('u1', 'opp-1');
    expect(prisma.pulseClaim.updateMany).not.toHaveBeenCalled();
  });

  it('refuses confirmation when the expiry job wins the update race', async () => {
    prisma.pulseClaim.findUnique.mockResolvedValue({
      id: 'c1', state: 'held', holdExpiresAt: new Date(Date.now() + 60_000),
    });
    prisma.pulseClaim.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.confirmClaim('u1', 'opp-1')).rejects.toThrow(
      'PULSE_HOLD_EXPIRED',
    );
  });

  it('throws when there is no claim to confirm', async () => {
    prisma.pulseClaim.findUnique.mockResolvedValue(null);
    await expect(service.confirmClaim('u1', 'opp-1')).rejects.toThrow('Claim not found');
  });
});
