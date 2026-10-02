import { flagsFor } from './transcript-flags';

describe('flagsFor', () => {
  it('flags a sentence the assistant could not place', () => {
    expect(flagsFor({ text: 'كلام فاضي', intent: 'unknown', outcome: 'clarify' })).toContain('unrecognized');
    expect(flagsFor({ text: 'احجز', outcome: 'clarify' })).toContain('unrecognized');
  });

  it('flags a half-sure reading separately from an unrecognised one', () => {
    const f = flagsFor({ text: 'محمد دفع', intent: 'pay', outcome: 'clarify', confidence: 0.45 });
    expect(f).toContain('low_confidence');
    expect(f).not.toContain('unrecognized');
  });

  it('flags numbers or slots the assistant refused to write, but not a plain permission refusal', () => {
    expect(flagsFor({ text: 'x', intent: 'book', outcome: 'planned', blockingCode: 'MATH_MISMATCH' })).toContain('blocked');
    const denied = flagsFor({ text: 'x', intent: 'book', outcome: 'denied', blockingCode: 'NO_PERMISSION' });
    expect(denied).toContain('denied');
    expect(denied).not.toContain('blocked');
  });

  it('flags limits, outages and failures', () => {
    expect(flagsFor({ text: 'x', outcome: 'limited' })).toContain('limited');
    expect(flagsFor({ text: 'x', outcome: 'unavailable' })).toContain('unavailable');
    expect(flagsFor({ text: 'x', outcome: 'failed' })).toContain('failed');
    expect(flagsFor({ text: 'x', outcome: 'error' })).toContain('failed');
  });

  it('flags nonsense, very long messages and the same sentence over and over', () => {
    expect(flagsFor({ text: 'هههههههههههههه', outcome: 'clarify', intent: 'unknown' })).toEqual(expect.arrayContaining(['noise', 'unrecognized']));
    expect(flagsFor({ text: 'ا'.repeat(10) + ' عايز'.repeat(80), outcome: 'planned' })).toContain('long');
    expect(flagsFor({ text: 'اقفل الملعب', outcome: 'planned', recentSame: 2 })).toContain('repeated');
    expect(flagsFor({ text: 'اقفل الملعب', outcome: 'planned', recentSame: 1 })).not.toContain('repeated');
  });

  it('leaves an ordinary understood request unflagged', () => {
    expect(flagsFor({ text: 'احجز بلايستيشن 1 بكرة 7 مساء لمحمد', intent: 'book', outcome: 'planned', confidence: 0.9 })).toEqual([]);
  });
});
