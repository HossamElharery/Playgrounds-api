import type { MorphTier } from '@prisma/client';

/**
 * Backend source of truth for Lobby Morphs: ids, tiers, weights and
 * acquisition rules. The frontend keeps a mirror list in its registry spec —
 * that duplication is the intentional parity check (adding a morph fails
 * both specs until both sides agree).
 */
export const MORPH_CATALOG_VERSION = 1;
export const CLASSIC_MORPH_ID = 'classic';

export interface MorphDef {
  id: string;
  tier: MorphTier;
  /** Relative weight inside its tier (integer). */
  weight: number;
  /** Can a roll produce it. */
  rollable: boolean;
  sinceVersion: number;
  /** Reserved for purchases / subscription / events — not enforced yet. */
  acquisition?: {
    priceCoins?: number;
    subscriptionOnly?: boolean;
    eventOnly?: boolean;
  };
}

/** Basis points, sum 10000. */
export const TIER_ODDS_BP = { COMMON: 7800, EPIC: 1900, MISK: 300 } as const;
/** The 10th roll without Epic+ is guaranteed Epic+. */
export const EPIC_PITY_ROLLS = 10;
/** The 50th roll without Misk is guaranteed Misk. */
export const MISK_PITY_ROLLS = 50;
/** In-tier weight multipliers: unowned morphs are 1.5× as likely. */
export const UNOWNED_WEIGHT_BOOST = { owned: 2, unowned: 3 } as const;
/** Minimum gap between two rolls of one user. */
export const MORPH_ROLL_COOLDOWN_MS = 1200;

const row = (id: string, tier: MorphTier): MorphDef => ({
  id,
  tier,
  weight: 10,
  rollable: true,
  sinceVersion: 1,
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
  row('golden_pharaoh', 'MISK'),
  row('tuktuk', 'MISK'),
]);

const BY_ID = new Map(MORPH_CATALOG.map((d) => [d.id, d]));

export function morphById(id: string): MorphDef | undefined {
  return BY_ID.get(id);
}

/** True for every catalog id and for `classic`. */
export function isKnownMorph(id: string): boolean {
  return id === CLASSIC_MORPH_ID || BY_ID.has(id);
}
