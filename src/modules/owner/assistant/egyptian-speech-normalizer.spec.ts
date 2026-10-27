import { egyptianInteger, escapeSpeechXml, normalizeEgyptianSpeech } from './egyptian-speech-normalizer';

describe('Egyptian speech normalization', () => {
  it('speaks operational amounts naturally', () => {
    expect(normalizeEgyptianSpeech('عليه 1,450 ج.م')).toBe('عليه ألف وربعمية وخمسين جنيه');
  });

  it('reads Egyptian phone numbers digit by digit', () => {
    expect(normalizeEgyptianSpeech('رقمه 01012345678')).toBe(
      'رقمه صفر، واحد، صفر، واحد، اتنين، تلاتة، أربعة، خمسة، ستة، سبعة، تمانية',
    );
  });

  it('normalizes Arabic digits and clock times', () => {
    expect(normalizeEgyptianSpeech('الحجز ١٩:٣٠ والسعر ٤٠٠ جنيه')).toBe(
      'الحجز الساعة سبعة ونص بالليل والسعر ربعمية جنيه',
    );
  });

  it('speaks quarters and exact hours the way Egyptians say them', () => {
    expect(normalizeEgyptianSpeech('من 09:15 لحد 10:45')).toBe(
      'من الساعة تسعة وربع الصبح لحد الساعة حداشر إلا ربع الصبح',
    );
  });

  it('reads ISO dashboard dates as a natural Egyptian date', () => {
    expect(normalizeEgyptianSpeech('الحجز يوم 2026-10-27')).toBe(
      'الحجز يوم سبعة وعشرين أكتوبر ألفين وستة وعشرين',
    );
  });

  it('supports large dashboard totals', () => {
    expect(egyptianInteger(2_108_305)).toBe('مليونين ومية وتمانية ألف وتلتمية وخمسة');
  });

  it('escapes model output before putting it in SSML', () => {
    expect(escapeSpeechXml('أحمد & <محمد>')).toBe('أحمد &amp; &lt;محمد&gt;');
  });
});
