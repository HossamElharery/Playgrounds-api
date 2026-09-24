import {
  CLASSIC_MORPH_ID,
  MORPH_CATALOG,
  TIER_ODDS_BP,
  isKnownMorph,
  morphById,
} from './morph-catalog';

describe('morph catalog', () => {
  it('matches the literal v1 id list (parity with the frontend registry spec)', () => {
    expect(MORPH_CATALOG.map((d) => d.id)).toEqual([
      'potato',
      'banana',
      'penguin',
      'rubber_duck',
      'cactus',
      'ball_buddy',
      'ghost',
      'taameya',
      'camel',
      'shai',
      'keeper',
      'referee',
      'dino',
      'robot',
      'golden_pharaoh',
      'tuktuk',
    ]);
  });

  it('has 10 common, 4 epic and 2 misk morphs, all rollable with weight 10', () => {
    const count = (t: string) =>
      MORPH_CATALOG.filter((d) => d.tier === t).length;
    expect([count('COMMON'), count('EPIC'), count('MISK')]).toEqual([10, 4, 2]);
    expect(MORPH_CATALOG.every((d) => d.rollable && d.weight === 10)).toBe(
      true,
    );
    expect(
      MORPH_CATALOG.some((d) => d.acquisition?.priceCoins !== undefined),
    ).toBe(false);
  });

  it('tier odds sum to 10000 basis points', () => {
    expect(TIER_ODDS_BP.COMMON + TIER_ODDS_BP.EPIC + TIER_ODDS_BP.MISK).toBe(
      10000,
    );
  });

  it('knows classic without storing it as a catalog row', () => {
    expect(isKnownMorph(CLASSIC_MORPH_ID)).toBe(true);
    expect(morphById(CLASSIC_MORPH_ID)).toBeUndefined();
    expect(isKnownMorph('golden_pharaoh')).toBe(true);
    expect(isKnownMorph('unicorn')).toBe(false);
  });
});
