import { GameResultsService } from './game-results.service';

function make(humans: string[]) {
  const prisma: any = { user: { findMany: jest.fn(async () => humans.map((id) => ({ id }))) } };
  const achievements = { bump: jest.fn(async () => 1) };
  return { svc: new GameResultsService(prisma, achievements as any), prisma, achievements };
}

describe('GameResultsService', () => {
  it('counts a played game and a win for each real player', async () => {
    const { svc, achievements } = make(['a', 'b']);
    await svc.record({ game: 'penalties', participants: ['a', 'b'], winners: ['a'] });
    expect(achievements.bump).toHaveBeenCalledWith('a', 'game.played');
    expect(achievements.bump).toHaveBeenCalledWith('b', 'game.played');
    expect(achievements.bump).toHaveBeenCalledWith('a', 'game.win.penalties');
    expect(achievements.bump).toHaveBeenCalledWith('a', 'game.win');
    expect(achievements.bump).not.toHaveBeenCalledWith('b', 'game.win');
  });

  it('counts nothing when fewer than two real players took part (guests, bots, a lone player)', async () => {
    const { svc, achievements } = make(['a']);
    await svc.record({ game: 'thief', participants: ['a', 'guest'], winners: ['a'] });
    expect(achievements.bump).not.toHaveBeenCalled();
  });

  it('asks the database for registered, active, non-guest players only', async () => {
    const { svc, prisma } = make(['a', 'b']);
    await svc.record({ game: 'camo', participants: ['a', 'b'], winners: ['a'] });
    expect(prisma.user.findMany.mock.calls[0][0].where).toMatchObject({ isGuest: false, status: 'active', deletedAt: null });
  });

  it('a draw gives nobody a win', async () => {
    const { svc, achievements } = make(['a', 'b']);
    await svc.record({ game: 'thief', participants: ['a', 'b'], winners: ['a', 'b'] });
    expect(achievements.bump).toHaveBeenCalledWith('a', 'game.played');
    expect(achievements.bump).not.toHaveBeenCalledWith('a', 'game.win');
  });

  it('a lone participant listed twice is still one player', async () => {
    const { svc, achievements } = make(['a']);
    await svc.record({ game: 'thief', participants: ['a', 'a'], winners: ['a'] });
    expect(achievements.bump).not.toHaveBeenCalled();
  });
});
