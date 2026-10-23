import { ReviewsService } from './reviews.service';

function make(opts: { qualifies?: boolean; linked?: boolean } = {}) {
  const prisma: any = {
    booking: { findUnique: jest.fn(async () => ({ id: 'b1', status: 'completed', userId: 'rater', splitShares: [] })) },
    playerRating: {
      create: jest.fn(async () => ({ id: 'r1' })),
      aggregate: jest.fn(async () => ({ _avg: { punctuality: 4 } })),
      findMany: jest.fn(async () => []),
    },
    user: { update: jest.fn(async () => ({ mvps: 1 })) },
  };
  const rewards = { onMvpAwarded: jest.fn(async () => undefined) };
  const grants = { grant: jest.fn(async () => ({ status: 'paid', amount: 10 })) };
  const qualification = { assess: jest.fn(async () => (opts.qualifies === false ? { ok: false, reason: 'venue_insider' } : { ok: true })) };
  const links = { areLinked: jest.fn(async () => !!opts.linked) };
  const svc = new ReviewsService(prisma, rewards as any, grants as any, qualification as any, links as any);
  (svc as any).recomputeReliability = jest.fn(async () => undefined);
  (svc as any).eligibleParticipants = jest.fn(async () => new Set(['rater', 'ratee']));
  return { svc, prisma, rewards, grants };
}
const dto = { bookingId: 'b1', rateeId: 'ratee', sportsmanship: 5, skill: 5, punctuality: 5, mvpVote: true };

describe('ReviewsService.ratePlayer rewards', () => {
  it('pays the rating coin through the capped door when the booking proves a real match', async () => {
    const { svc, grants, rewards } = make();
    await svc.ratePlayer('rater', dto as never);
    expect(grants.grant).toHaveBeenCalledWith(expect.objectContaining({ userId: 'rater', amount: 10, refKey: 'rating:r1', dailyCapped: true }));
    expect(rewards.onMvpAwarded).toHaveBeenCalledWith('ratee', 1, true);
  });

  it('pays nothing and counts no MVP when the booking does not qualify (venue on both sides, last minute...)', async () => {
    const { svc, grants, rewards } = make({ qualifies: false });
    await svc.ratePlayer('rater', dto as never);
    expect(grants.grant).not.toHaveBeenCalled();
    expect(rewards.onMvpAwarded).toHaveBeenCalledWith('ratee', 1, false);
  });

  it('pays nothing for rating your own other account', async () => {
    const { svc, grants } = make({ linked: true });
    await svc.ratePlayer('rater', dto as never);
    expect(grants.grant).not.toHaveBeenCalled();
  });

  it('refuses to rate yourself', async () => {
    const { svc } = make();
    await expect(svc.ratePlayer('rater', { ...dto, rateeId: 'rater' } as never)).rejects.toThrow('Cannot rate yourself');
  });
});
