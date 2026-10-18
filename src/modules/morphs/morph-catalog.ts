import type { MorphTier } from '@prisma/client';

export const MORPH_CATALOG_VERSION = 6;
export const CLASSIC_MORPH_ID = 'classic';

export interface MorphDef {
  id: string;
  tier: MorphTier;
  weight: number;
  rollable: boolean;
  sinceVersion: number;
  acquisition?: {
    priceCoins?: number;
    subscriptionOnly?: boolean;
    eventOnly?: boolean;
  };
}

export const TIER_ODDS_BP = { COMMON: 7800, EPIC: 1900, MISK: 300 } as const;
export const EPIC_PITY_ROLLS = 10;
export const MISK_PITY_ROLLS = 50;
export const UNOWNED_WEIGHT_BOOST = { owned: 2, unowned: 3 } as const;
export const MORPH_ROLL_COOLDOWN_MS = 1200;

const row = (id: string, tier: MorphTier, sinceVersion = 1): MorphDef => ({
  id,
  tier,
  weight: 10,
  rollable: true,
  sinceVersion,
});

export const MORPH_CATALOG: readonly MorphDef[] = Object.freeze([
  row('potato', 'COMMON'),
  row('banana', 'COMMON'),
  row('penguin', 'COMMON'),
  row('rubber_duck', 'COMMON'),
  row('cactus', 'COMMON'),
  row('ball_buddy', 'COMMON'),
  row('ghost', 'COMMON'),
  row('taameya', 'COMMON'),
  row('camel', 'COMMON'),
  row('shai', 'COMMON'),
  row('keeper', 'EPIC'),
  row('referee', 'EPIC'),
  row('dino', 'EPIC'),
  row('robot', 'EPIC'),
  row('ultra', 'EPIC', 4),
  row('gamer', 'EPIC', 4),
  row('golden_pharaoh', 'MISK'),
  row('tuktuk', 'MISK'),
  row('royal_falcon', 'MISK', 2),
  row('nile_queen', 'MISK', 3),
  row('griff', 'MISK', 5),
  row('rabid', 'MISK', 5),
  row('tiny_planet', 'MISK', 5),
  row('pilot_rooster', 'MISK', 6),
]);

const BY_ID = new Map(MORPH_CATALOG.map((d) => [d.id, d]));

export function morphById(id: string): MorphDef | undefined {
  return BY_ID.get(id);
}

export function isKnownMorph(id: string): boolean {
  return id === CLASSIC_MORPH_ID || BY_ID.has(id);
}
