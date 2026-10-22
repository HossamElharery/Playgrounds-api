import { CamoProgressService } from './camo-progress.service';
import { CAMO_DEFAULTS } from './camo-settings.service';

function make(row: any = null, user: any = { coinsBalance: 50, isGuest: false }) {
  const tx = {
    camoStats: { update: jest.fn(async () => undefined), upsert: jest.fn(async () => undefined) },
    user: { update: jest.fn(async () => undefined), updateMany: jest.fn(async () => ({ count: 1 })) },
    coinLedgerEntry: { create: jest.fn(async () => undefined) },
  };
  const prisma: any = {
    camoStats: { findUnique: jest.fn(async () => row) },
    user: { findUnique: jest.fn(async () => user) },
    $transaction: jest.fn(async (fn: any) => fn(tx)),
  };
  const svc = new CamoProgressService(prisma, { current: { ...CAMO_DEFAULTS } } as any);
  return { svc, tx, prisma };
}
const player = (over: any = {}) => ({ isBot: false, userId: 'u1', guest: false, match: { roles: ['hider', 'seeker', 'hider'], caught: 1, cardsGiven: 3, yellows: 0, bestSurvivalMs: 0, awards: [], stamps: 2 }, ...over }) as any;

describe('CamoProgressService', () => {
  it('rewards a registered winner with xp, coins and the ledger entry, and completes missions once', async () => {
    const { svc, tx } = make({ xp: 0, coinsToday: 0, coinsDay: null, missions: {} });
    await svc.award(player(), true);
    const stat = (tx.camoStats.update.mock.calls[0] as any[])[0].data;
    expect(stat.xp).toBe(20 + 40 + 15 + 8); // match + win + 3 reds + 1 survived round
    expect(stat.coinsToday).toBe(16);
    const coins = (tx.user.update.mock.calls[0] as any[])[0].data.coinsBalance.increment;
    expect(coins).toBe(16 + 2 * 15); // match + win, plus two missions done (three reds, stamp)
    expect((tx.coinLedgerEntry.create.mock.calls[0] as any[])[0].data.reason).toBe('camo_match_and_mission');
  });

  it('guests earn xp but no coins', async () => {
    const { svc, tx } = make({ xp: 10, coinsToday: 0, coinsDay: null, missions: {} });
    await svc.award(player({ guest: true }), true);
    expect(tx.camoStats.update).toHaveBeenCalled();
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(tx.coinLedgerEntry.create).not.toHaveBeenCalled();
  });

  it('stops at the daily coin cap and never throws', async () => {
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const { svc, tx } = make({ xp: 0, coinsToday: 100, coinsDay: day, missions: { day, progress: {}, done: ['stay_twice', 'three_reds', 'stamp_paint'] } });
    await svc.award(player(), false);
    expect(tx.user.update).not.toHaveBeenCalled();
    const broken = make();
    (broken.prisma.camoStats.findUnique as jest.Mock).mockRejectedValue(new Error('db down'));
    await expect(broken.svc.award(player(), true)).resolves.toBeUndefined();
  });

  it('buying spends the coins inside a transaction guarded against a double spend, and refuses guests', async () => {
    const { svc, tx } = make({ xp: 70, cosmetics: { owned: [], equipped: {} } }, { coinsBalance: 100, isGuest: false });
    expect(await svc.buy('u1', 'redcard_confetti')).toEqual({ ok: true, cost: 60 });
    expect((tx.user.updateMany.mock.calls[0] as any[])[0].where.coinsBalance).toEqual({ gte: 60 });
    expect((tx.coinLedgerEntry.create.mock.calls[0] as any[])[0].data.amount).toBe(-60);
    const guest = make({ xp: 70, cosmetics: { owned: [], equipped: {} } }, { coinsBalance: 100, isGuest: true });
    expect(await guest.svc.buy('u1', 'redcard_confetti')).toEqual({ ok: false, reason: 'guest' });
  });
});
