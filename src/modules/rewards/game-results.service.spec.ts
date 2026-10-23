import { GameResultsService } from './game-results.service';

type H = { id: string; trustedAt: Date | null };
function make(humans: H[], linked: Record<string, string[]> = {}, pairCounts: (id: string, metric: string) => number = () => 1) {
  const prisma: any = { user: { findMany: jest.fn(async () => humans) } };
  const achievements = { bump: jest.fn(async (id: string, metric: string) => (metric.startsWith('pair.') ? pairCounts(id, metric) : 1)) };
  const links = { linkedIds: jest.fn(async (id: string) => new Set(linked[id] ?? [])) };
  return { svc: new GameResultsService(prisma, achievements as any, links as any), prisma, achievements };
}
const T = new Date();
const trusted = (id: string): H => ({ id, trustedAt: T });
const fresh = (id: string): H => ({ id, trustedAt: null });

describe('GameResultsService', () => {
  it('counts a played game and a win against a trusted real player', async () => {
    const { svc, achievements } = make([trusted('a'), trusted('b')]);
    await svc.record({ game: 'penalties', participants: ['a', 'b'], winners: ['a'] });
    expect(achievements.bump).toHaveBeenCalledWith('a', 'game.played');
    expect(achievements.bump).toHaveBeenCalledWith('b', 'game.played');
    expect(achievements.bump).toHaveBeenCalledWith('a', 'game.win.penalties');
    expect(achievements.bump).toHaveBeenCalledWith('a', 'game.win');
    expect(achievements.bump).not.toHaveBeenCalledWith('b', 'game.win');
  });

  it('counts nothing when the only opponents are brand-new, untrusted accounts (a farm of free accounts)', async () => {
    const { svc, achievements } = make([trusted('a'), fresh('x'), fresh('y')]);
    await svc.record({ game: 'thief', participants: ['a', 'x', 'y'], winners: ['a'] });
    expect(achievements.bump).not.toHaveBeenCalledWith('a', 'game.win');
    expect(achievements.bump).not.toHaveBeenCalledWith('a', 'game.played');
  });

  it('an untrusted player beating a trusted one still progresses (the coins wait for their trust)', async () => {
    const { svc, achievements } = make([fresh('n'), trusted('t')]);
    await svc.record({ game: 'thief', participants: ['n', 't'], winners: ['n'] });
    expect(achievements.bump).toHaveBeenCalledWith('n', 'game.win');
  });

  it('players on the same device are one person: they do not feed each other', async () => {
    const { svc, achievements } = make([trusted('a'), trusted('b')], { a: ['b'], b: ['a'] });
    await svc.record({ game: 'penalties', participants: ['a', 'b'], winners: ['a'] });
    expect(achievements.bump).not.toHaveBeenCalled();
  });

  it('a pair of players can only add a few wins to each other: past the pair limit the win does not count', async () => {
    const { svc, achievements } = make([trusted('a'), trusted('b')], {}, (_id, metric) => (metric.startsWith('pair.win:') ? 0 : 1));
    await svc.record({ game: 'penalties', participants: ['a', 'b'], winners: ['a'] });
    expect(achievements.bump).toHaveBeenCalledWith('a', 'pair.win:b');
    expect(achievements.bump).not.toHaveBeenCalledWith('a', 'game.win');
    expect(achievements.bump).toHaveBeenCalledWith('a', 'game.played');
  });

  it('counts nothing when fewer than two real players took part (guests, bots, a lone player)', async () => {
    const { svc, achievements } = make([trusted('a')]);
    await svc.record({ game: 'thief', participants: ['a', 'guest'], winners: ['a'] });
    expect(achievements.bump).not.toHaveBeenCalled();
  });

  it('asks the database for registered, active, non-guest, non-blocked players only', async () => {
    const { svc, prisma } = make([trusted('a'), trusted('b')]);
    await svc.record({ game: 'camo', participants: ['a', 'b'], winners: ['a'] });
    expect(prisma.user.findMany.mock.calls[0][0].where).toMatchObject({ isGuest: false, status: 'active', deletedAt: null, rewardsBlockedAt: null });
  });

  it('a draw gives nobody a win', async () => {
    const { svc, achievements } = make([trusted('a'), trusted('b')]);
    await svc.record({ game: 'thief', participants: ['a', 'b'], winners: ['a', 'b'] });
    expect(achievements.bump).toHaveBeenCalledWith('a', 'game.played');
    expect(achievements.bump).not.toHaveBeenCalledWith('a', 'game.win');
  });
});
