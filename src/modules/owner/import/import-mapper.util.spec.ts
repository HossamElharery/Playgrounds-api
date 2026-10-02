import {
  courtKey,
  durationUnitFromHeader,
  excelSerialToYmd,
  normalizeHeader,
  parseDate,
  parseDuration,
  parseMoneyMinor,
  parsePaymentMethod,
  parseSource,
  parseTime,
  suggestMapping,
} from './import-mapper.util';

describe('suggestMapping', () => {
  it('reads an Arabic venue sheet', () => {
    const { mapping, matched } = suggestMapping(['التاريخ', 'الساعة', 'الملعب', 'اسم العميل', 'رقم الموبايل', 'السعر', 'المدفوع', 'ملاحظات']);
    expect(mapping).toMatchObject({ date: 0, time: 1, court: 2, customerName: 3, phone: 4, price: 5, paid: 6, notes: 7 });
    expect(matched).toBe(8);
  });

  it('reads an English sheet and leaves unknown columns unmapped', () => {
    const { mapping } = suggestMapping(['Date', 'Start', 'End', 'Pitch', 'Customer', 'Mobile', 'Total', 'Deposit', 'Method', 'Whatever']);
    expect(mapping).toMatchObject({ date: 0, time: 1, endTime: 2, court: 3, customerName: 4, phone: 5, price: 6, paid: 7, method: 8 });
    expect(Object.values(mapping)).not.toContain(9);
  });

  it('uses a column only once and tolerates "ال", diacritics and alef spellings', () => {
    const { mapping } = suggestMapping(['اليوم', 'من', 'إلى', 'الملعب', 'الإجمالي']);
    expect(mapping).toMatchObject({ date: 0, time: 1, endTime: 2, court: 3, price: 4 });
    expect(normalizeHeader('  المُدّة (ساعة) ')).toBe('المده ساعه');
  });
});

describe('parseDate', () => {
  it.each([
    ['2026-10-05', '2026-10-05'],
    ['5/10/2026', '2026-10-05'],
    ['05-10-26', '2026-10-05'],
    ['٥/١٠/٢٠٢٦', '2026-10-05'],
    ['5 أكتوبر 2026', '2026-10-05'],
    ['Oct 5, 2026', '2026-10-05'],
    ['25/12/2026', '2026-12-25'],
    ['12/25/2026', '2026-12-25'],
    ['2026-10-05T18:30:00', '2026-10-05'],
  ])('%s → %s', (raw, ymd) => expect(parseDate(raw)?.ymd).toBe(ymd));

  it('rejects impossible and non-date text', () => {
    expect(parseDate('31/02/2026')).toBeNull();
    expect(parseDate('السبت')).toBeNull();
    expect(parseDate('')).toBeNull();
    expect(parseDate('abc')).toBeNull();
  });

  it('understands Excel serial numbers, including the time in the fraction', () => {
    expect(excelSerialToYmd(46300)).toBe('2026-10-05');
    expect(parseDate('46300')).toEqual({ ymd: '2026-10-05' });
    expect(parseDate('46300.75')).toEqual({ ymd: '2026-10-05', minutes: 18 * 60 });
  });

  it('a day with no year takes the current year, day-first', () => {
    expect(parseDate('5/10', new Date('2026-06-01T00:00:00Z'))?.ymd).toBe('2026-10-05');
  });
});

describe('parseTime', () => {
  it.each([
    ['18:30', 18 * 60 + 30, false],
    ['6:30 PM', 18 * 60 + 30, false],
    ['٦ م', 18 * 60, false],
    ['6 مساءً', 18 * 60, false],
    ['10 ص', 10 * 60, false],
    ['12 ص', 0, false],
    ['12 م', 12 * 60, false],
    ['0.75', 18 * 60, false],
    ['6:30', 6 * 60 + 30, true],
    ['18', 18 * 60, false],
    ['2026-10-05 20:15', 20 * 60 + 15, false],
  ])('%s → %d minutes (ambiguous=%s)', (raw, minutes, ambiguous) => {
    expect(parseTime(raw)).toEqual({ minutes, ambiguous });
  });

  it('rejects nonsense', () => {
    expect(parseTime('abc')).toBeNull();
    expect(parseTime('25:00')).toBeNull();
    expect(parseTime('7:99')).toBeNull();
  });
});

describe('parseDuration', () => {
  it.each([
    ['1', undefined, 60],
    ['1.5', undefined, 90],
    ['90', undefined, 90],
    ['2', 'hours', 120],
    ['2', 'minutes', 2],
    ['ساعة ونص', undefined, 90],
    ['ساعتين', undefined, 120],
    ['1:30', undefined, 90],
    ['2 ساعات', undefined, 120],
    ['45 دقيقة', undefined, 45],
  ] as const)('%s (%s) → %d', (raw, unit, minutes) => expect(parseDuration(raw, unit)).toBe(minutes));

  it('reads the unit from the header', () => {
    expect(durationUnitFromHeader('المدة (دقيقة)')).toBe('minutes');
    expect(durationUnitFromHeader('عدد الساعات')).toBe('hours');
    expect(durationUnitFromHeader('المدة')).toBeUndefined();
  });
});

describe('parseMoneyMinor', () => {
  it.each([
    ['300', 30000],
    ['1,500', 150000],
    ['1500 ج', 150000],
    ['١٥٠٠ جنيه', 150000],
    ['300.50', 30050],
    ['EGP 250', 25000],
    ['٣٠٠٫٥٠', 30050],
  ])('%s → %d', (raw, minor) => expect(parseMoneyMinor(raw)).toBe(minor));

  it('is null for text and empty cells', () => {
    expect(parseMoneyMinor('مدفوع')).toBeNull();
    expect(parseMoneyMinor('')).toBeNull();
  });
});

describe('payment method, source and court', () => {
  it('maps what owners write', () => {
    expect(parsePaymentMethod('كاش')).toBe('cash');
    expect(parsePaymentMethod('انستاباي')).toBe('instapay');
    expect(parsePaymentMethod('فودافون كاش')).toBe('wallet');
    expect(parsePaymentMethod('فيزا')).toBe('card');
    expect(parsePaymentMethod('غير معروف')).toBeNull();
  });

  it('keeps recognised channels as presets and everything else as the owner\'s own label', () => {
    expect(parseSource('واتساب')).toEqual({ key: 'whatsapp' });
    expect(parseSource('تليفون')).toEqual({ key: 'phone' });
    expect(parseSource('جاي بنفسه')).toEqual({ key: 'walk_in' });
    expect(parseSource('شركة المصري')).toEqual({ label: 'شركة المصري' });
    expect(parseSource('')).toEqual({});
  });

  it('court names match through "ملعب", "ال" and spelling', () => {
    expect(courtKey('ملعب 1')).toBe(courtKey('الملعب ١'));
    expect(courtKey('Court A')).toBe(courtKey('a'));
    expect(courtKey('ملعب 1')).not.toBe(courtKey('ملعب 2'));
  });
});
