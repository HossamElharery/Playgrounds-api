import { MORPH_CATALOG, type MorphDef } from './morph-catalog';
import { drawTier, rollMorph, type RollInput } from './morph-roll.util';

/** Deterministic `randomInt` (mulberry32). */
function seeded(seed: number): (max: number) => number {
  let a = seed >>> 0;
  return (max: number) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    const r = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    return Math.floor(r * max);
  };
}

/** Constant draw that still honours the `randomInt(max)` contract. */
const fixed = (v: number) => (max: number) => Math.min(v, max - 1);

const base = (over: Partial<RollInput> = {}): RollInput => ({
  catalog: MORPH_CATALOG,
  equippedMorphId: 'classic',
  ownedIds: new Set(),
  rollsSinceEpicOrBetter: 0,
  rollsSinceMisk: 0,
  randomInt: seeded(42),
  ...over,
});

describe('rollMorph', () => {
  it('matches tier odds within ±0.5 pp over 200k rolls with pity disabled', () => {
    const counts = { COMMON: 0, EPIC: 0, MISK: 0 };
    const randomInt = seeded(7);
    const n = 200_000;
    for (let i = 0; i < n; i++) {
      const r = rollMorph(
        base({
          randomInt,
          epicPityRolls: Number.MAX_SAFE_INTEGER,
          miskPityRolls: Number.MAX_SAFE_INTEGER,
        }),
      );
      counts[r.tier]++;
    }
    expect(Math.abs((counts.COMMON / n) * 100 - 78)).toBeLessThan(0.5);
    expect(Math.abs((counts.EPIC / n) * 100 - 19)).toBeLessThan(0.5);
    expect(Math.abs((counts.MISK / n) * 100 - 3)).toBeLessThan(0.5);
  });

  it('draws the tier against cumulative basis points', () => {
    expect(drawTier(() => 0)).toBe('COMMON');
    expect(drawTier(() => 7799)).toBe('COMMON');
    expect(drawTier(() => 7800)).toBe('EPIC');
    expect(drawTier(() => 9699)).toBe('EPIC');
    expect(drawTier(() => 9700)).toBe('MISK');
    expect(drawTier(() => 9999)).toBe('MISK');
  });

  it('never returns the equipped morph when alternatives exist', () => {
    const randomInt = seeded(3);
    for (const def of MORPH_CATALOG) {
      for (let i = 0; i < 300; i++) {
        const r = rollMorph(base({ equippedMorphId: def.id, randomInt }));
        expect(r.morphId).not.toBe(def.id);
      }
    }
  });

  it('applies Epic pity on exactly the 10th roll without Epic+', () => {
    const alwaysCommon = fixed(0); // tier draw 0 → COMMON; pity split 0 → EPIC
    let state = { e: 0, m: 0 };
    const tiers: string[] = [];
    for (let i = 1; i <= 10; i++) {
      const r = rollMorph(
        base({
          randomInt: alwaysCommon,
          rollsSinceEpicOrBetter: state.e,
          rollsSinceMisk: state.m,
        }),
      );
      tiers.push(r.tier);
      state = { e: r.nextRollsSinceEpicOrBetter, m: r.nextRollsSinceMisk };
      if (i < 10) expect(r.pityApplied).toBeNull();
      else expect(r.pityApplied).toBe('EPIC');
    }
    expect(tiers.slice(0, 9).every((t) => t === 'COMMON')).toBe(true);
    expect(tiers[9]).toBe('EPIC');
    expect(state.e).toBe(0);
  });

  it('splits Epic pity between EPIC and MISK by their relative odds', () => {
    const epic = rollMorph(
      base({ randomInt: fixed(1899), rollsSinceEpicOrBetter: 9 }),
    );
    const misk = rollMorph(
      base({ randomInt: fixed(1900), rollsSinceEpicOrBetter: 9 }),
    );
    expect([epic.tier, epic.pityApplied]).toEqual(['EPIC', 'EPIC']);
    expect([misk.tier, misk.pityApplied]).toEqual(['MISK', 'EPIC']);
  });

  it('applies Misk pity on exactly the 50th roll without Misk', () => {
    const r49 = rollMorph(base({ randomInt: fixed(0), rollsSinceMisk: 48 }));
    expect(r49.tier).toBe('COMMON');
    const r50 = rollMorph(base({ randomInt: fixed(0), rollsSinceMisk: 49 }));
    expect(r50.tier).toBe('MISK');
    expect(r50.pityApplied).toBe('MISK');
  });

  it('resets counters correctly', () => {
    const common = rollMorph(
      base({
        randomInt: fixed(0),
        rollsSinceEpicOrBetter: 3,
        rollsSinceMisk: 5,
      }),
    );
    expect([
      common.nextRollsSinceEpicOrBetter,
      common.nextRollsSinceMisk,
    ]).toEqual([4, 6]);
    const epic = rollMorph(
      base({
        randomInt: fixed(8000),
        rollsSinceEpicOrBetter: 3,
        rollsSinceMisk: 5,
      }),
    );
    expect(epic.tier).toBe('EPIC');
    expect([epic.nextRollsSinceEpicOrBetter, epic.nextRollsSinceMisk]).toEqual([
      0, 6,
    ]);
    const misk = rollMorph(
      base({
        randomInt: fixed(9990),
        rollsSinceEpicOrBetter: 3,
        rollsSinceMisk: 5,
      }),
    );
    expect(misk.tier).toBe('MISK');
    expect([misk.nextRollsSinceEpicOrBetter, misk.nextRollsSinceMisk]).toEqual([
      0, 0,
    ]);
  });

  it('boosts unowned morphs inside a tier (×1.5)', () => {
    // Own every common except potato: potato weight 30 vs 9×20 → 30/210 ≈ 14.3%
    // (vs 10% without the boost).
    const owned = new Set(
      MORPH_CATALOG.filter((d) => d.tier === 'COMMON' && d.id !== 'potato').map(
        (d) => d.id,
      ),
    );
    const randomInt = seeded(11);
    let potato = 0;
    let commons = 0;
    for (let i = 0; i < 60_000; i++) {
      const r = rollMorph(base({ ownedIds: owned, randomInt }));
      if (r.tier !== 'COMMON') continue;
      commons++;
      if (r.morphId === 'potato') potato++;
    }
    const share = potato / commons;
    expect(share).toBeGreaterThan(0.13);
    expect(share).toBeLessThan(0.157);
  });

  it('handles a single-morph tier (falls back to the equipped one)', () => {
    const catalog: MorphDef[] = [
      {
        id: 'solo',
        tier: 'COMMON',
        weight: 10,
        rollable: true,
        sinceVersion: 1,
      },
    ];
    const r = rollMorph(
      base({ catalog, equippedMorphId: 'solo', randomInt: fixed(0) }),
    );
    expect(r.morphId).toBe('solo');
  });

  it('steps down a tier that has no rollable morph', () => {
    const catalog: MorphDef[] = [
      { id: 'a', tier: 'COMMON', weight: 10, rollable: true, sinceVersion: 1 },
      { id: 'b', tier: 'MISK', weight: 10, rollable: false, sinceVersion: 1 },
    ];
    const r = rollMorph(base({ catalog, randomInt: fixed(9999) }));
    expect(r.tier).toBe('COMMON');
    expect(r.morphId).toBe('a');
  });

  it('never produces a rollable:false morph', () => {
    const catalog: MorphDef[] = MORPH_CATALOG.map((d) =>
      d.id === 'potato'
        ? { ...d, rollable: false, acquisition: { priceCoins: 100 } }
        : d,
    );
    const randomInt = seeded(5);
    for (let i = 0; i < 20_000; i++) {
      expect(rollMorph(base({ catalog, randomInt })).morphId).not.toBe(
        'potato',
      );
    }
  });

  it('tolerates an unknown equipped id and an empty owned set', () => {
    const r = rollMorph(
      base({
        equippedMorphId: 'retired_morph',
        ownedIds: new Set(),
        randomInt: seeded(9),
      }),
    );
    expect(MORPH_CATALOG.some((d) => d.id === r.morphId)).toBe(true);
  });
});
