import { TrustService } from './trust.service';
import { TRUST_COOLOFF_MS, VENUE_NEW_TRUST_PER_WEEK } from '../coins-policy';

const ok = (moneyVerified = false) => ({ ok: true as const, moneyVerified, venueId: 'v1', userId: 'u1' });

function make(user: Record<string, unknown> = {}) {
  const prisma: any = {
    user: {
      findUnique: jest.fn(async () => ({ trustedAt: null, trustCandidateAt: null, rewardsBlockedAt: null, ...user })),
      count: jest.fn(async () => 0),
      updateMany: jest.fn(async () => ({ count: 1 })),
      findMany: jest.fn(async () => []),
      update: jest.fn(async () => undefined),
      findUniqueOrThrow: jest.fn(async () => ({ coinsBalance: 500 })),
    },
    coinGrant: { updateMany: jest.fn(async () => ({ count: 2 })), aggregate: jest.fn(async () => ({ _sum: { amount: 120 } })) },
    coinLedgerEntry: { create: jest.fn(async () => undefined) },
    auditLogEntry: { create: jest.fn(async () => undefined) },
    venue: { update: jest.fn(async () => undefined) },
    $transaction: jest.fn(async (fn: any) => fn(prisma)),
    $queryRaw: jest.fn(async () => [{ acquired: true }]),
  };
  const grants = { markTrusted: jest.fn(async () => true) };
  const links = { linkedIds: jest.fn(async () => new Set<string>()) };
  const qualification = { assess: jest.fn(async (): Promise<any> => ok()) };
  const svc = new TrustService(prisma, grants as any, links as any, qualification as any);
  return { svc, prisma, grants, links, qualification };
}

describe('TrustService.considerCheckIn', () => {
  it('a qualifying check-in only makes a candidate: nobody is trusted at once', async () => {
    const { svc, prisma, grants } = make();
    expect(await svc.considerCheckIn('u1', 'b1', ok())).toBe('candidate');
    expect(grants.markTrusted).not.toHaveBeenCalled();
    expect((prisma.user.updateMany.mock.calls[0] as any[])[0]).toMatchObject({
      where: { id: 'u1', trustedAt: null, trustCandidateAt: null },
      data: { trustBookingId: 'b1', trustVenueId: 'v1' },
    });
  });

  it('a payment verified by the gateway is trusted at once', async () => {
    const { svc, grants } = make();
    expect(await svc.considerCheckIn('u1', 'b1', ok(true))).toBe('trusted');
    expect(grants.markTrusted).toHaveBeenCalledWith('u1');
  });

  it('a venue can make only a few new players a week', async () => {
    const { svc, prisma } = make();
    prisma.user.count.mockResolvedValue(VENUE_NEW_TRUST_PER_WEEK);
    expect(await svc.considerCheckIn('u1', 'b1', ok())).toBe('venue_capped');
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });

  it('a blocked player never becomes a candidate; a trusted one is left alone', async () => {
    expect(await make({ rewardsBlockedAt: new Date() }).svc.considerCheckIn('u1', 'b1', ok())).toBe('blocked');
    expect(await make({ trustedAt: new Date() }).svc.considerCheckIn('u1', 'b1', ok())).toBe('already');
  });
});

describe('TrustService.promoteDue', () => {
  const due = [{ id: 'u1', trustBookingId: 'b1' }];

  it('only looks at candidates whose cool-off is over', async () => {
    const { svc, prisma } = make();
    await svc.promoteDue();
    const where = (prisma.user.findMany.mock.calls[0] as any[])[0].where;
    expect(where.trustCandidateAt.lte.getTime()).toBeLessThanOrEqual(Date.now() - TRUST_COOLOFF_MS + 1000);
    expect(where.rewardsBlockedAt).toBeNull();
  });

  it('trusts a candidate whose booking still qualifies, and tells the listeners (referral)', async () => {
    const { svc, prisma } = make();
    prisma.user.findMany.mockResolvedValue(due);
    const heard: Array<[string, string | null]> = [];
    svc.onTrusted(async (u, b) => { heard.push([u, b]); });
    expect(await svc.promoteDue()).toEqual({ trusted: 1, dropped: 0 });
    expect(heard).toEqual([['u1', 'b1']]);
  });

  it('drops a candidate whose booking no longer qualifies (venue frozen, refunded...)', async () => {
    const { svc, prisma, qualification, grants } = make();
    prisma.user.findMany.mockResolvedValue(due);
    qualification.assess.mockResolvedValue({ ok: false, reason: 'venue_not_eligible' });
    expect(await svc.promoteDue()).toEqual({ trusted: 0, dropped: 1 });
    expect(grants.markTrusted).not.toHaveBeenCalled();
    expect((prisma.user.updateMany.mock.calls[0] as any[])[0].data).toMatchObject({ trustCandidateAt: null });
  });

  it('drops a candidate who shares a device with someone already trusted', async () => {
    const { svc, prisma, links, grants } = make();
    prisma.user.findMany.mockResolvedValue(due);
    links.linkedIds.mockResolvedValue(new Set(['twin']));
    prisma.user.count.mockResolvedValue(1);
    expect(await svc.promoteDue()).toEqual({ trusted: 0, dropped: 1 });
    expect(grants.markTrusted).not.toHaveBeenCalled();
  });
});

describe('TrustService admin actions', () => {
  it('revoking removes trust, voids waiting rewards, takes back recent coins (never below zero) and is audited', async () => {
    const { svc, prisma } = make();
    prisma.user.findUniqueOrThrow.mockResolvedValue({ coinsBalance: 80 });
    const out = await svc.revoke('u1', 'admin1', { clawback: true, block: true });
    expect(out.clawedBack).toBe(80);
    expect((prisma.user.update.mock.calls[0] as any[])[0].data).toMatchObject({ trustedAt: null, rewardsBlockedAt: expect.any(Date) });
    expect(prisma.coinGrant.updateMany).toHaveBeenCalledWith({ where: { userId: 'u1', status: 'pending' }, data: { status: 'void' } });
    expect((prisma.coinLedgerEntry.create.mock.calls[0] as any[])[0].data).toMatchObject({ amount: -80, reason: 'rewards_revoked' });
    expect(prisma.auditLogEntry.create).toHaveBeenCalled();
  });

  it('freezing a venue can undo the players it made in the last two weeks', async () => {
    const { svc, prisma } = make();
    prisma.user.findMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);
    expect(await svc.setVenueFrozen('v1', 'admin1', true, true)).toEqual({ revoked: 2 });
    expect((prisma.venue.update.mock.calls[0] as any[])[0].data.rewardsFrozenAt).toBeInstanceOf(Date);
  });

  it('unfreezing only clears the flag', async () => {
    const { svc, prisma } = make();
    expect(await svc.setVenueFrozen('v1', 'admin1', false, true)).toEqual({ revoked: 0 });
    expect((prisma.venue.update.mock.calls[0] as any[])[0].data.rewardsFrozenAt).toBeNull();
  });
});
