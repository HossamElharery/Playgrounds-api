import {
  assertCustomSourceLabel,
  isPresetSourceKey,
  normalizeSourceLabel,
  sourceDisplay,
} from './source-label.util';

describe('source labels', () => {
  it('dedupes Arabic and English by NFKC + collapsed whitespace + lowercase', () => {
    expect(normalizeSourceLabel('  واتســـاب  ')).toBe(normalizeSourceLabel('واتســـاب'));
    expect(normalizeSourceLabel('Playtomic')).toBe(normalizeSourceLabel('  PLAYTOMIC '));
    expect(normalizeSourceLabel('WhatsApp')).toBe(normalizeSourceLabel('whatsapp'));
  });

  it('rejects punctuation-only or overlong labels', () => {
    expect(() => assertCustomSourceLabel('!!!')).toThrow();
    expect(() => assertCustomSourceLabel('   ')).toThrow();
    expect(() => assertCustomSourceLabel('x'.repeat(61))).toThrow();
    expect(assertCustomSourceLabel('  Playtomic  ')).toBe('Playtomic');
  });

  it('recognizes preset keys', () => {
    expect(isPresetSourceKey('walk_in')).toBe(true);
    expect(isPresetSourceKey('Playtomic')).toBe(false);
  });

  it('displays platform vs custom vs preset', () => {
    expect(sourceDisplay('platform', null, null)).toEqual({ key: 'platform', label: 'Matchena' });
    expect(sourceDisplay('manual', 'whatsapp', null).label).toBe('WhatsApp');
    expect(sourceDisplay('manual', null, 'Playtomic').label).toBe('Playtomic');
  });
});
