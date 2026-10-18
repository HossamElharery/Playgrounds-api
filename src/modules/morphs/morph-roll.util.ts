import type { MorphTier } from '@prisma/client';
import {
  EPIC_PITY_ROLLS,
  MISK_PITY_ROLLS,
  TIER_ODDS_BP,
  UNOWNED_WEIGHT_BOOST,
  type MorphDef,
} from './morph-catalog';

export interface RollInput {
  catalog: readonly MorphDef[];
  equippedMorphId: string;
  ownedIds: ReadonlySet<string>;
  rollsSinceEpicOrBetter: number;
  rollsSinceMisk: number;
  randomInt: (maxExclusive: number) => number;
  epicPityRolls?: number;
  miskPityRolls?: number;
}

export interface RollResult {
  morphId: string;
  tier: MorphTier;
  pityApplied: MorphTier | null;
  nextRollsSinceEpicOrBetter: number;
  nextRollsSinceMisk: number;
}

const TIER_ORDER: readonly MorphTier[] = ['COMMON', 'EPIC', 'MISK'];

export function drawTier(randomInt: (max: number) => number): MorphTier {
  const r = randomInt(10000);
  if (r < TIER_ODDS_BP.COMMON) return 'COMMON';
  if (r < TIER_ODDS_BP.COMMON + TIER_ODDS_BP.EPIC) return 'EPIC';
  return 'MISK';
}

function pickTier(input: RollInput): {
  tier: MorphTier;
  pity: MorphTier | null;
} {
  const miskPity = input.miskPityRolls ?? MISK_PITY_ROLLS;
  const epicPity = input.epicPityRolls ?? EPIC_PITY_ROLLS;
  if (input.rollsSinceMisk + 1 >= miskPity)
    return { tier: 'MISK', pity: 'MISK' };
  if (input.rollsSinceEpicOrBetter + 1 >= epicPity) {
    const total = TIER_ODDS_BP.EPIC + TIER_ODDS_BP.MISK;
    const tier = input.randomInt(total) < TIER_ODDS_BP.EPIC ? 'EPIC' : 'MISK';
    return { tier, pity: 'EPIC' };
  }
  return { tier: drawTier(input.randomInt), pity: null };
}

function candidatesFor(
  input: RollInput,
  tier: MorphTier,
): { tier: MorphTier; defs: MorphDef[] } {
  for (let i = TIER_ORDER.indexOf(tier); i >= 0; i--) {
    const t = TIER_ORDER[i];
    const all = input.catalog.filter((d) => d.rollable && d.tier === t);
    if (!all.length) continue;
    const withoutEquipped = all.filter((d) => d.id !== input.equippedMorphId);
    return { tier: t, defs: withoutEquipped.length ? withoutEquipped : all };
  }
  throw new Error('MORPH_CATALOG_EMPTY');
}

export function rollMorph(input: RollInput): RollResult {
  const picked = pickTier(input);
  const { tier, defs } = candidatesFor(input, picked.tier);
  const weights = defs.map(
    (d) =>
      d.weight *
      (input.ownedIds.has(d.id)
        ? UNOWNED_WEIGHT_BOOST.owned
        : UNOWNED_WEIGHT_BOOST.unowned),
  );
  const total = weights.reduce((a, b) => a + b, 0);
  let r = input.randomInt(total);
  let index = 0;
  while (r >= weights[index]) {
    r -= weights[index];
    index++;
  }
  const epicOrBetter = tier === 'EPIC' || tier === 'MISK';
  return {
    morphId: defs[index].id,
    tier,
    pityApplied: picked.pity,
    nextRollsSinceEpicOrBetter: epicOrBetter
      ? 0
      : input.rollsSinceEpicOrBetter + 1,
    nextRollsSinceMisk: tier === 'MISK' ? 0 : input.rollsSinceMisk + 1,
  };
}
