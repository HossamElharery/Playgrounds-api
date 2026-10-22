import { COSMETICS, MISSIONS, applyMissions, canBuy, coinsFor, equip, levelOf, xpFor, xpForLevel, type MatchDelta, type ProgressSettings } from './camo-progress';

const S: ProgressSettings = { xpPerMatch: 20, xpWinBonus: 40, xpPerRedCard: 5, xpPerSurvivedRound: 8, coinsPerMatch: 8, coinsWinBonus: 8, coinsDailyCap: 100, missionCoins: 15 };
const d = (over: Partial<MatchDelta> = {}): MatchDelta => ({ won: false, survivedRounds: 0, redCards: 0, stampsUsed: 0, rounds: 3, ...over });

describe('camo progress', () => {
  it('xp rewards playing, winning, red cards and surviving; levels grow slower', () => {
    expect(xpFor(d(), S)).toBe(20);
    expect(xpFor(d({ won: true, redCards: 3, survivedRounds: 2 }), S)).toBe(20 + 40 + 15 + 16);
    expect(levelOf(0)).toBe(1);
    expect(levelOf(xpForLevel(2))).toBe(2);
    expect(levelOf(xpForLevel(5) - 1)).toBe(4);
    expect(xpForLevel(10) - xpForLevel(9)).toBeGreaterThan(xpForLevel(3) - xpForLevel(2));
  });

  it('coins stop at the daily cap and guests earn none', () => {
    expect(coinsFor(d({ won: true }), S, 0, false)).toBe(16);
    expect(coinsFor(d(), S, 95, false)).toBe(5);
    expect(coinsFor(d(), S, 100, false)).toBe(0);
    expect(coinsFor(d({ won: true }), S, 0, true)).toBe(0);
  });

  it('missions accumulate across matches in a day, complete once, and reset on a new day', () => {
    let r = applyMissions(null, d({ survivedRounds: 1, redCards: 2 }), '2026-10-22');
    expect(r.completed).toEqual([]);
    r = applyMissions(r.state, d({ survivedRounds: 1, redCards: 1, stampsUsed: 2 }), '2026-10-22');
    expect(r.completed.map((m) => m.id).sort()).toEqual(['stamp_paint', 'stay_twice', 'three_reds']);
    r = applyMissions(r.state, d({ survivedRounds: 3 }), '2026-10-22');
    expect(r.completed).toEqual([]); // each completes once
    r = applyMissions(r.state, d({ survivedRounds: 1 }), '2026-10-23');
    expect(r.state.progress['stay_twice']).toBe(1);
    expect(MISSIONS.length).toBe(3);
  });

  it('cosmetics need the level and the coins, cannot be bought twice or by guests, and equip only what you own', () => {
    const own = { owned: [], equipped: {} };
    expect(canBuy('redcard_confetti', 1, 500, own, false)).toEqual({ ok: false, reason: 'level' });
    expect(canBuy('redcard_confetti', 2, 10, own, false)).toEqual({ ok: false, reason: 'coins' });
    expect(canBuy('redcard_confetti', 2, 100, own, true)).toEqual({ ok: false, reason: 'guest' });
    expect(canBuy('redcard_confetti', 2, 100, own, false)).toEqual({ ok: true, cost: 60 });
    expect(canBuy('redcard_confetti', 2, 100, { owned: ['redcard_confetti'], equipped: {} }, false)).toEqual({ ok: false, reason: 'owned' });
    expect(canBuy('nope', 9, 999, own, false)).toEqual({ ok: false, reason: 'unknown' });
    expect(equip('name_gold', 'name_style', own)).toBeNull();
    expect(equip('name_gold', 'name_style', { owned: ['name_gold'], equipped: {} })).toEqual({ owned: ['name_gold'], equipped: { name_style: 'name_gold' } });
    expect(equip('name_gold', 'win_dance', { owned: ['name_gold'], equipped: {} })).toBeNull();
    expect(COSMETICS.every((c) => c.cost > 0)).toBe(true); // nothing sold for real money, nothing that changes play
  });
});
