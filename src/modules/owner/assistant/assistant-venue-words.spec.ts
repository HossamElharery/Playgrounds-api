import { OwnerAssistantService } from './owner-assistant.service';
import type { AssistantReading } from './assistant.types';

const user = { id: 'u1', roles: ['owner'] } as never;
const future = () => new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);

const reading = (over: Partial<AssistantReading>): AssistantReading => ({
  intent: 'help', courtIds: [], allCourts: false, date: future(), fromMins: 1140, toMins: null, durationMinutes: 60,
  customerName: '', customerPhone: '', totalAmount: null, paidAmount: null, remainingAmount: null, paymentMethod: null,
  sourceKey: null, expenseCategory: null, rangeKey: null, reason: '', confidence: 0.9, newDate: null, newFromMins: null,
  newCourtId: null, question: '', ...over,
} as AssistantReading);

type Court = { id: string; name: string; sport: { activityKind: string; nameAr: string; nameEn: string } | null };
const court = (id: string, name: string, kind: string, sportAr: string): Court => ({ id, name, sport: { activityKind: kind, nameAr: sportAr, nameEn: sportAr } });

function build(courts: Court[], read: AssistantReading, extras: { bookings?: unknown[]; summary?: unknown } = {}) {
  const rows = courts.map((c) => ({ ...c, pricingRules: [], slotDurationMins: 60, format: null, gamingConfig: null, tableConfig: null }));
  const prisma = {
    venue: { findUnique: jest.fn().mockResolvedValue({ id: 'v1', ownerId: 'u1', nameAr: 'مكان', nameEn: 'Place', currency: 'EGP', country: { timezone: 'Africa/Cairo' } }) },
    court: { findMany: jest.fn().mockResolvedValue(rows) },
    booking: { findMany: jest.fn().mockResolvedValue(extras.bookings ?? []) },
    calendarBlock: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const summary = { getSummary: jest.fn().mockResolvedValue(extras.summary) };
  const nlu = { enabled: true, read: jest.fn().mockResolvedValue(read) };
  const service = new OwnerAssistantService(prisma as never, nlu as never, { slotConflict: jest.fn().mockResolvedValue(null) } as never, summary as never, {} as never);
  return { service, prisma };
}

const lounge = [court('c1', 'PS5 Room 1', 'gaming-station', 'بلايستيشن'), court('c2', 'VIP Room', 'gaming-station', 'بلايستيشن')];
const club = [court('t1', 'Table 1', 'table-game', 'بلياردو'), court('t2', 'Table 1', 'table-game', 'بينج بونج')];
const padel = [court('p1', 'Court 1', 'racket-court', 'بادل'), court('p2', 'Court 2', 'racket-court', 'بادل')];

describe('the assistant speaks the owner\'s own business', () => {
  it('help gives examples with the venue\'s own units, never another sport\'s', async () => {
    const { service } = build(lounge, reading({ intent: 'help' }));
    const plan = await service.ask(user, 'v1', 'ساعدني');
    expect(plan.reply.ar).toContain('احجز PS5 Room 1');
    expect(plan.reply.ar).toContain('اقفل VIP Room');
    expect(plan.reply.ar).not.toContain('ملعب');
    expect(plan.reply.en).toContain('book PS5 Room 1');
  });

  it('a billiards club is asked "which table", and two tables with one name are told apart by sport', async () => {
    const { service } = build(club, reading({ intent: 'book', customerName: 'محمد' }));
    const plan = await service.ask(user, 'v1', 'احجز لمحمد');
    expect(plan.reply.ar).toBe('أي ترابيزة بالظبط؟ عندك: Table 1 (بلياردو)، Table 1 (بينج بونج).');
    expect(plan.reply.en).toContain('Which table exactly?');
  });

  it('a PlayStation lounge is asked "which station"; a padel venue "which court"', async () => {
    const a = await build(lounge, reading({ intent: 'book' })).service.ask(user, 'v1', 'احجز');
    expect(a.reply.ar).toContain('أي جهاز بالظبط؟');
    const b = await build(padel, reading({ intent: 'book' })).service.ask(user, 'v1', 'احجز');
    expect(b.reply.ar).toContain('أي ملعب بالظبط؟');
  });

  it('closing a slot also uses the right noun and lists every unit when it is unclear', async () => {
    const { service } = build(club, reading({ intent: 'block', fromMins: 1020, toMins: 1140 }));
    const plan = await service.ask(user, 'v1', 'اقفل من 5 لـ 7');
    expect(plan.reply.ar).toContain('أي ترابيزة بالظبط؟');
    expect(plan.reply.ar).toContain('Table 1 (بلياردو)');
  });
});

describe('cancelling a paid booking through the assistant', () => {
  const booking = (paid: number) => ({
    id: 'b1', code: 'MAN-1', guestName: 'سامي', court: { name: 'PS5 Room 1' }, slotStart: new Date(Date.now() + 86_400_000),
    slotEnd: new Date(Date.now() + 90_000_000), totalAmount: 15000, currency: 'EGP', payments: paid ? [{ amount: paid }] : [],
  });
  const cancel = (text: string, paid: number) =>
    build(lounge, reading({ intent: 'cancel', customerName: 'سامي', fromMins: null }), { bookings: [booking(paid)] }).service.ask(user, 'v1', text);

  it('never guesses what happens to money already paid: it asks, and offers nothing to confirm yet', async () => {
    const plan = await cancel('الغي حجز سامي', 15000);
    expect(plan.needsConfirm).toBe(false);
    expect(plan.actions).toEqual([]);
    expect(plan.reply.ar).toContain('اتدفع فيه 150 ج.م');
    expect(plan.reply.ar).toContain('رجّع الفلوس');
  });

  it('"and refund" hands everything back — and says so in the confirmation', async () => {
    const plan = await cancel('الغي حجز سامي ورجّع الفلوس', 15000);
    expect(plan.needsConfirm).toBe(true);
    expect(plan.actions[0]).toMatchObject({ kind: 'cancel_booking', bookingId: 'b1', refundAmount: 15000 });
    expect(plan.summary?.ar).toContain('هرجّع 150 ج.م للعميل');
  });

  it('"and keep the deposit" keeps it — and says so in the confirmation', async () => {
    const plan = await cancel('الغي حجز سامي واحتفظ بالعربون', 15000);
    expect(plan.actions[0]).toMatchObject({ kind: 'cancel_booking', refundAmount: 0 });
    expect(plan.summary?.ar).toContain('هتحتفظ بـ 150 ج.م كعربون');
  });

  it('a booking that took no money needs no question', async () => {
    const plan = await cancel('الغي حجز سامي', 0);
    expect(plan.needsConfirm).toBe(true);
    expect(plan.actions[0]).toEqual(expect.objectContaining({ kind: 'cancel_booking', bookingId: 'b1' }));
    expect((plan.actions[0] as { refundAmount?: number }).refundAmount).toBeUndefined();
  });

  it('what a customer was already given back is not counted as still held', async () => {
    const withRefund = { ...booking(15000), payments: [{ amount: 15000 }, { amount: -5000 }] };
    const { service, prisma } = build(lounge, reading({ intent: 'cancel', customerName: 'سامي', fromMins: null }), { bookings: [withRefund] });
    const plan = await service.ask(user, 'v1', 'الغي حجز سامي ورجّع الفلوس');
    expect(plan.actions[0]).toMatchObject({ refundAmount: 10000 });
    // The query itself must read refunds too, otherwise a taken-back payment would look like money held.
    const include = prisma.booking.findMany.mock.calls[0][0].include;
    expect(include.payments.where.status).toEqual({ in: ['paid', 'refunded'] });
  });
});

describe('"how much did I make today?" matches the drawer', () => {
  const totals = { bookings: 1, collectedRevenue: 20000, outstanding: 0, expenses: 0, netProfit: 20000 };
  it('says what was really received, and why it differs from the game revenue', async () => {
    const summary = { totals, cashbook: { received: 30000, advance: 10000, late: 0 } };
    const plan = await build(lounge, reading({ intent: 'money', rangeKey: 'today' }), { summary }).service.ask(user, 'v1', 'عملت كام النهاردة');
    expect(plan.reply.ar).toContain('إيراد ألعابها 200 ج.م');
    expect(plan.reply.ar).toContain('اتقبض فعليًا 300 ج.م (منها 100 ج.م عربون لحجوزات جاية)');
    expect(plan.reply.en).toContain('Actually received: 300 EGP');
  });

  it('does not repeat itself when the two numbers are the same', async () => {
    const summary = { totals, cashbook: { received: 20000, advance: 0, late: 0 } };
    const plan = await build(lounge, reading({ intent: 'money', rangeKey: 'today' }), { summary }).service.ask(user, 'v1', 'عملت كام النهاردة');
    expect(plan.reply.ar).not.toContain('اتقبض فعليًا');
  });
});
