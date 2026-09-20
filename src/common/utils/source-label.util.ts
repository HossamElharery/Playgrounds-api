const PRESET_KEYS = ['walk_in', 'phone', 'whatsapp', 'other_platform'] as const;
export type ManualSourceKey = (typeof PRESET_KEYS)[number];

export function isPresetSourceKey(value: string | undefined | null): value is ManualSourceKey {
  return !!value && (PRESET_KEYS as readonly string[]).includes(value);
}

export function normalizeSourceLabel(raw: string): string {
  return raw
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('ar');
}

export function assertCustomSourceLabel(raw: string): string {
  const trimmed = raw.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (trimmed.length === 0 || trimmed.length > 60) {
    throw new Error('INVALID_SOURCE_LABEL');
  }
  if (/^[\p{P}\p{S}\s]+$/u.test(trimmed)) {
    throw new Error('INVALID_SOURCE_LABEL');
  }
  return trimmed;
}

export function sourceDisplay(
  source: 'platform' | 'manual',
  sourceKey?: string | null,
  sourceLabel?: string | null,
): { key: string; label: string } {
  if (source === 'platform') return { key: 'platform', label: 'Matchena' };
  if (sourceLabel) return { key: sourceLabel, label: sourceLabel };
  switch (sourceKey) {
    case 'phone':
      return { key: 'phone', label: 'Phone' };
    case 'whatsapp':
      return { key: 'whatsapp', label: 'WhatsApp' };
    case 'other_platform':
      return { key: 'other_platform', label: 'Other platform' };
    default:
      return { key: 'walk_in', label: 'Walk-in' };
  }
}

export const SOURCE_PRESETS = [
  { key: 'walk_in', labelAr: 'جاي بنفسه', labelEn: 'Walk-in' },
  { key: 'phone', labelAr: 'تليفون', labelEn: 'Phone' },
  { key: 'whatsapp', labelAr: 'واتساب', labelEn: 'WhatsApp' },
  { key: 'other_platform', labelAr: 'منصة أخرى', labelEn: 'Other platform' },
] as const;
