import { suggestMapping } from './import-mapper.util';
import { DEFAULT_IMPORT_OPTIONS, normalizeBookingRow, normalizeCustomerRow, type ImportContext } from './import-rows.util';

const hours = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), { closed: false, open: '16:00', close: '02:00' }]));
const rule = { daysOfWeek: [], startTime: '00:00', endTime: '24:00', priceAmount: 20000, currency: 'EGP', priority: 0 };

function ctx(over: Partial<ImportContext> = {}, headers: string[] = []): ImportContext {
  return {
    timeZone: 'Africa/Cairo',
    now: new Date('2026-10-02T10:00:00.000Z'),
    courts: [
      { id: 'c1', name: 'ملعب 1', slotDurationMins: 60, pricingRules: [rule] },
      { id: 'c2', name: 'ملعب 2', slotDurationMins: 60, pricingRules: [] },
    ],
    weeklyHours: hours as never,
    headers,
    options: { ...DEFAULT_IMPORT_OPTIONS },
    ...over,
  };
}

const headers = ['التاريخ', 'الساعة', 'الملعب', 'اسم العميل', 'رقم الموبايل', 'السعر', 'المدفوع', 'طريقة الدفع', 'ملاحظات'];
const mapping = suggestMapping(headers).mapping;
const run = (cells: string[], over?: Partial<ImportContext>) => normalizeBookingRow(cells, mapping, ctx(over, headers));
const codes = (r: ReturnType<typeof run>) => r.issues.map((i) => i.code);

describe('normalizeBookingRow', () => {
  it('reads a normal Arabic row: local time becomes the right UTC instant, money becomes piastres', () => {
    const r = run(['5/10/2026', '18:00', 'ملعب 1', 'أحمد', '٠١٠١٢٣٤٥٦٧٨', '300', '300', 'كاش', 'عميل دائم']);
    expect(r.issues).toEqual([]);
    const b = r.booking!;
    // Cairo is UTC+3 on 5 Oct 2026 (summer time ends 30 Oct).
    expect(b.startsAt.toISOString()).toBe('2026-10-05T15:00:00.000Z');
    expect(b.durationMinutes).toBe(60);
    expect(b.priceAmount).toBe(30000);
    expect(b.paidAmount).toBe(30000);
    expect(b.paymentStatus).toBe('paid');
    expect(b.customerPhone).toBe('+201012345678');
    expect(b.courtId).toBe('c1');
    expect(b.notes).toBe('عميل دائم');
  });

  it('a deposit makes it partial', () => {
    const r = run(['2026-10-05', '9 م', 'ملعب 1', 'أحمد', '', '300', '100', '', '']);
    expect(r.booking).toMatchObject({ paymentStatus: 'partial', paidAmount: 10000 });
    expect(r.booking!.startsAt.toISOString()).toBe('2026-10-05T18:00:00.000Z');
  });

  it('"6" with no marker is taken as evening because the venue opens at 16:00', () => {
    const r = run(['5/10/2026', '6', 'ملعب 1', 'أحمد', '', '300', '', '', '']);
    expect(r.booking!.time).toBe('18:00');
    expect(codes(r)).toContain('TIME_GUESSED');
  });

  it('an unpaid-looking blank "paid" cell: past games count as paid, future ones as unpaid (auto)', () => {
    const past = run(['1/9/2026', '8 م', 'ملعب 1', '', '', '300', '', '', '']);
    expect(past.booking!.paymentStatus).toBe('paid');
    const future = run(['1/12/2026', '8 م', 'ملعب 1', '', '', '300', '', '', '']);
    expect(future.booking!.paymentStatus).toBe('unpaid');
    const forced = run(['1/9/2026', '8 م', 'ملعب 1', '', '', '300', '', '', ''], { options: { ...DEFAULT_IMPORT_OPTIONS, whenPaidMissing: 'unpaid' } });
    expect(forced.booking!.paymentStatus).toBe('unpaid');
  });

  it('understands "مدفوع" and clamps an over-payment with a warning', () => {
    expect(run(['5/10/2026', '8 م', 'ملعب 1', '', '', '300', 'مدفوع', '', '']).booking!.paymentStatus).toBe('paid');
    const over = run(['5/10/2026', '8 م', 'ملعب 1', '', '', '300', '500', '', '']);
    expect(over.booking!.paidAmount).toBe(30000);
    expect(codes(over)).toContain('PAID_CLAMPED');
  });

  it('a missing price comes from the venue\'s own rates, or is an error when there are none', () => {
    const quoted = run(['5/10/2026', '8 م', 'ملعب 1', '', '', '', '', '', '']);
    expect(quoted.booking!.priceAmount).toBe(20000);
    expect(codes(quoted)).toContain('PRICE_FROM_RATES');
    expect(codes(run(['5/10/2026', '8 م', 'ملعب 2', '', '', '', '', '', '']))).toContain('PRICE_MISSING');
  });

  it('says exactly which cell it did not understand', () => {
    expect(codes(run(['كذا', '8 م', 'ملعب 1', '', '', '300', '', '', '']))).toEqual(['DATE_INVALID']);
    expect(codes(run(['5/10/2026', 'بكرة', 'ملعب 1', '', '', '300', '', '', '']))).toEqual(['TIME_INVALID']);
    const unknown = run(['5/10/2026', '8 م', 'ملعب 9', '', '', '300', '', '', '']);
    expect(unknown.issues[0]).toMatchObject({ code: 'COURT_UNKNOWN', detail: 'ملعب 9' });
    expect(codes(run(['5/10/2026', '8 م', 'ملعب 1', '', '', 'ثلاثمية', '', '', '']))).toEqual(['PRICE_INVALID']);
  });

  it('with no court column the only court is used; with several it asks', () => {
    const noCourt = suggestMapping(['التاريخ', 'الساعة', 'السعر']).mapping;
    const one = ctx({ courts: [ctx().courts[0]] }, ['التاريخ', 'الساعة', 'السعر']);
    expect(normalizeBookingRow(['5/10/2026', '8 م', '300'], noCourt, one).booking!.courtId).toBe('c1');
    expect(normalizeBookingRow(['5/10/2026', '8 م', '300'], noCourt, ctx({}, ['التاريخ', 'الساعة', 'السعر'])).issues[0].code).toBe('COURT_REQUIRED');
    const chosen = ctx({ options: { ...DEFAULT_IMPORT_OPTIONS, defaultCourtId: 'c2' } }, ['التاريخ', 'الساعة', 'السعر']);
    expect(normalizeBookingRow(['5/10/2026', '8 م', '300'], noCourt, chosen).booking!.courtId).toBe('c2');
  });

  it('an end-time column gives the duration, even across midnight', () => {
    const h = ['التاريخ', 'من', 'إلى', 'الملعب', 'السعر'];
    const m = suggestMapping(h).mapping;
    const out = normalizeBookingRow(['5/10/2026', '23:00', '01:00', 'ملعب 1', '400'], m, ctx({}, h));
    expect(out.booking!.durationMinutes).toBe(120);
  });

  it('a duration column in hours or minutes', () => {
    const h = ['التاريخ', 'الساعة', 'المدة (دقيقة)', 'الملعب', 'السعر'];
    const m = suggestMapping(h).mapping;
    expect(normalizeBookingRow(['5/10/2026', '8 م', '90', 'ملعب 1', '400'], m, ctx({}, h)).booking!.durationMinutes).toBe(90);
    const h2 = ['التاريخ', 'الساعة', 'عدد الساعات', 'الملعب', 'السعر'];
    expect(normalizeBookingRow(['5/10/2026', '8 م', '2', 'ملعب 1', '400'], suggestMapping(h2).mapping, ctx({}, h2)).booking!.durationMinutes).toBe(120);
  });

  it('warns (but keeps the row) outside opening hours and for odd phone numbers', () => {
    const r = run(['5/10/2026', '10 ص', 'ملعب 1', 'أحمد', '12', '300', '300', '', '']);
    expect(codes(r)).toEqual(expect.arrayContaining(['OUTSIDE_HOURS', 'PHONE_INVALID']));
    expect(r.booking).toBeDefined();
  });

  it('a date-time stored in one Excel cell gives both date and time', () => {
    const h = ['التاريخ', 'الملعب', 'السعر'];
    const out = normalizeBookingRow(['46300.75', 'ملعب 1', '300'], suggestMapping(h).mapping, ctx({}, h));
    expect(out.booking!.date).toBe('2026-10-05');
    expect(out.booking!.time).toBe('18:00');
  });
});

describe('normalizeCustomerRow', () => {
  const m = suggestMapping(['الاسم', 'الموبايل', 'ملاحظات']).mapping;
  it('keys the profile exactly like the customers list does', () => {
    const r = normalizeCustomerRow(['أحمد', '01012345678', 'بيحب 7 م'], m);
    expect(r.customer).toMatchObject({ key: 'm:+201012345678', name: 'أحمد', note: 'بيحب 7 م' });
    expect(normalizeCustomerRow(['أحمد', '', ''], m).customer!.key).toBe('n:أحمد');
  });
  it('needs a name or a phone', () => {
    expect(normalizeCustomerRow(['', '', 'x'], m).issues[0].code).toBe('CUSTOMER_EMPTY');
  });
});
