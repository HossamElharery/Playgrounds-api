/**
 * What a bookable unit is called at a venue: a court, a station, a table. Owners of a PlayStation
 * lounge or a billiards club must never read "ملعب" in their own tools.
 */
export type UnitNounKind = 'court' | 'station' | 'table' | 'unit';

interface Words {
  ar: { one: string; many: string; which: string };
  en: { one: string; many: string };
}

const WORDS: Record<UnitNounKind, Words> = {
  court: { ar: { one: 'ملعب', many: 'ملاعب', which: 'أي ملعب' }, en: { one: 'court', many: 'courts' } },
  station: { ar: { one: 'جهاز', many: 'أجهزة', which: 'أي جهاز' }, en: { one: 'station', many: 'stations' } },
  table: { ar: { one: 'ترابيزة', many: 'ترابيزات', which: 'أي ترابيزة' }, en: { one: 'table', many: 'tables' } },
  unit: { ar: { one: 'وحدة', many: 'وحدات', which: 'أي وحدة' }, en: { one: 'unit', many: 'units' } },
};

export function unitNounKindOf(activityKind?: string | null): Exclude<UnitNounKind, 'unit'> {
  if (activityKind === 'gaming-station') return 'station';
  if (activityKind === 'table-game') return 'table';
  return 'court';
}

/** One noun when every unit is the same kind, the neutral «unit» when a venue mixes kinds. */
export function unitWords(activityKinds: Array<string | null | undefined>): Words & { kind: UnitNounKind } {
  const kinds = new Set(activityKinds.map(unitNounKindOf));
  const kind: UnitNounKind = kinds.size === 1 ? [...kinds][0] : kinds.size === 0 ? 'court' : 'unit';
  return { ...WORDS[kind], kind };
}
