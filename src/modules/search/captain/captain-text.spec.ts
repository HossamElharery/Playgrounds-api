import { bestFaq, heuristicReading, normalize, plainLine, safeAppPath, tokens, type FaqRow } from './captain-text';

const faq = (over: Partial<FaqRow>): FaqRow => ({
  id: 'f',
  questionAr: '',
  questionEn: '',
  answerAr: '',
  answerEn: '',
  ctaPath: null,
  ctaLabelAr: null,
  ctaLabelEn: null,
  ...over,
});

describe('captain text helpers', () => {
  it('flattens Arabic spelling variants', () => {
    expect(normalize('إلغاء الحَجْز')).toBe(normalize('الغاء الحجز'));
    expect(normalize('مدرسة')).toBe(normalize('مدرسه'));
  });

  it('drops stopwords and the definite article', () => {
    expect(tokens('إزاي الغي الحجز؟')).toEqual(['الغي', 'حجز']);
  });

  it('matches the real FAQ whose question shares the meaningful words', () => {
    const rows = [
      faq({ id: 'a', questionAr: 'ازاي الغي الحجز؟', answerAr: 'من حجوزاتي دوس إلغاء.' }),
      faq({ id: 'b', questionAr: 'ازاي ادفع بالمحفظة؟', answerAr: 'اختار فودافون كاش.' }),
    ];
    expect(bestFaq('عايز الغي حجزي', rows)?.id).toBe('a');
  });

  it('refuses a match that rests on one stray word', () => {
    const rows = [faq({ id: 'a', questionAr: 'ازاي الغي الحجز؟', answerAr: 'ماتشنا ممتاز' })];
    expect(bestFaq('ماتشنا', rows)).toBeNull();
    expect(bestFaq('', rows)).toBeNull();
  });

  it('only ever lets an in-app path through', () => {
    expect(safeAppPath('app/bookings')).toBe('app/bookings');
    expect(safeAppPath('/register')).toBe('register');
    expect(safeAppPath('https://evil.example')).toBeNull();
    expect(safeAppPath('mailto:a@b.c')).toBeNull();
    expect(safeAppPath('../x')).toBeNull();
    expect(safeAppPath(null)).toBeNull();
  });

  it('strips links and markup from a model-written line', () => {
    const out = plainLine('تمام! **افتح** https://x.co/a <b>دلوقتي</b>');
    expect(out).not.toMatch(/[<>*]|http/);
    expect(out).toContain('افتح');
  });

  describe('keyword fallback when no model is reachable', () => {
    const catalog = {
      sports: [{ slug: 'padel', nameAr: 'بادل', nameEn: 'Padel' }],
      districts: [{ slug: 'maadi', nameAr: 'المعادي', nameEn: 'Maadi' }],
    };
    it('finds a sport and an area by name and reads "cheap" and "near"', () => {
      const r = heuristicReading('عايز بادل رخيص في المعادي', catalog);
      expect(r).toMatchObject({ intent: 'find_venues', sport: 'padel', district: 'maadi', cheap: true });
      expect(heuristicReading('عايز حاجة قريبة', catalog)).toMatchObject({ intent: 'find_venues', nearMe: true });
    });
    it('does not pretend to understand an unrelated sentence', () => {
      expect(heuristicReading('النهاردة جو حلو', catalog).intent).toBe('unknown');
    });
  });
});
