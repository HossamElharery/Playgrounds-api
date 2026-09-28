import {
  CLASSIC_MORPH_ID,
  MORPH_CATALOG,
  MORPH_CATALOG_VERSION,
  TIER_ODDS_BP,
  isKnownMorph,
  morphById,
} from './morph-catalog';

describe('morph catalog', () => {
  it('matches the literal v5 id list (parity with the frontend registry spec)', () => {
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
      'ultra',
      'gamer',
      'golden_pharaoh',
      'tuktuk',
      'royal_falcon',
      'nile_queen',
      'griff',
      'rabid',
      'tiny_planet',
    ]);
  });

  it('has 10 common, 6 epic and 7 misk morphs, all rollable with weight 10', () => {
    const count = (t: string) =>
      MORPH_CATALOG.filter((d) => d.tier === t).length;
    expect([count('COMMON'), count('EPIC'), count('MISK')]).toEqual([10, 6, 7]);
    expect(MORPH_CATALOG.every((d) => d.rollable && d.weight === 10)).toBe(
      true,
    );
    expect(
      MORPH_CATALOG.some((d) => d.acquisition?.priceCoins !== undefined),
    ).toBe(false);
  });

  it('introduces the Royal Falcon in catalog v2 without changing previous entries', () => {
    expect(morphById('royal_falcon')).toMatchObject({ tier: 'MISK', sinceVersion: 2 });
    expect(
      MORPH_CATALOG.filter(
        (d) => !['royal_falcon', 'nile_queen', 'ultra', 'gamer', 'griff', 'rabid', 'tiny_planet'].includes(d.id),
      ).every((d) => d.sinceVersion === 1),
    ).toBe(true);
  });

  it('introduces the Nile Queen as Misk in catalog v3', () => {
    expect(morphById('nile_queen')).toMatchObject({ tier: 'MISK', sinceVersion: 3, rollable: true });
  });

  it('introduces the Ultra and the Gamer as Epic in catalog v4', () => {
    expect(morphById('ultra')).toMatchObject({ tier: 'EPIC', sinceVersion: 4, rollable: true });
    expect(morphById('gamer')).toMatchObject({ tier: 'EPIC', sinceVersion: 4, rollable: true });
  });

  it('introduces the imported characters as Misk in catalog v5', () => {
    expect(MORPH_CATALOG_VERSION).toBe(5);
    for (const id of ['griff', 'rabid', 'tiny_planet']) {
      expect(morphById(id)).toMatchObject({ tier: 'MISK', sinceVersion: 5, rollable: true });
    }
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
