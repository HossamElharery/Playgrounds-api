import { InsightsService } from './insights.service';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.interface';

const owner: AuthenticatedUser = { id: 'owner-1', phone: '', name: 'Owner', roles: ['owner'] };
const cairo = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00+03:00`);
const NOW = new Date('2026-09-30T09:00:00Z'); // a Wednesday
const SUNDAYS = ['2026-09-06', '2026-09-13', '2026-09-20', '2026-09-27'];

const rule = (over: Record<string, unknown> = {}) => ({
  id: 'r-base', daysOfWeek: [], startTime: '10:00', endTime: '22:00', priceAmount: 20000, currency: 'EGP',
  priority: 0, kind: 'base', validFrom: null, validUntil: null, ...over,
});

function build(opts: { rules?: any[]; approvedAt?: Date; extraBookings?: any[]; discounts?: any[]; noBookings?: boolean } = {}) {
  const busy = SUNDAYS.flatMap((d) => [
    { courtId: 'c1', slotStart: cairo(d, '10:00'), slotEnd: cairo(d, '14:00') },
    { courtId: 'c1', slotStart: cairo(d, '18:00'), slotEnd: cairo(d, '22:00') },
  ]);
  const created: any[] = [];
  const tx: any = {
    pricingRule: {
      create: jest.fn(async ({ data }: any) => { const r = { id: `new-${created.length + 1}`, ...data }; created.push(r); return r; }),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    pricingDiscount: {
      create: jest.fn(async ({ data }: any) => ({ id: 'd1', ...data })),
      update: jest.fn().mockResolvedValue({}),
    },
    auditLogEntry: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma: any = {
    ...tx,
    venue: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'v1', ownerId: 'owner-1', weeklyHours: Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), { closed: false, open: '10:00', close: '22:00' }])),
        approvedAt: opts.approvedAt ?? new Date('2026-09-01T00:00:00Z'), createdAt: new Date('2026-08-01T00:00:00Z'), priceFromCurrency: 'EGP',
        country: { timezone: 'Africa/Cairo' },
        courts: [{ id: 'c1', name: 'Court 1', sport: { activityKind: 'field-sport' }, pricingRules: opts.rules ?? [rule()] }],
      }),
    },
    court: { findUnique: jest.fn().mockResolvedValue({ venueId: 'v1' }) },
    booking: {
      findMany: jest.fn().mockResolvedValue(opts.noBookings ? [] : [...busy, ...(opts.extraBookings ?? [])]),
      findFirst: jest.fn().mockResolvedValue(opts.noBookings ? null : { slotStart: cairo('2026-09-06', '10:00') }),
    },
    calendarBlock: { findMany: jest.fn().mockResolvedValue([]) },
    pricingDiscount: {
      ...tx.pricingDiscount,
      findMany: jest.fn().mockResolvedValue(opts.discounts ?? []),
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn(),
    },
    pricingRule: { ...tx.pricingRule, findMany: jest.fn().mockResolvedValue([{ priceAmount: 15000 }]) },
    $transaction: jest.fn(async (arg: any) => (typeof arg === 'function' ? arg(tx) : Promise.all(arg))),
  };
  return { svc: new InsightsService(prisma), prisma, tx, created };
}

const window = { venueId: 'v1', courtId: 'c1', weekday: 0, startHour: 14, endHour: 16 };

beforeEach(() => jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'queueMicrotask'] }));
afterEach(() => jest.useRealTimers());

describe('InsightsService.occupancy', () => {
  it('finds Court 1 empty on Sunday afternoons and suggests a discount with a lost-revenue estimate', async () => {
    const { svc } = build();
    const res = await svc.occupancy(owner, 'v1');
    expect(res.hasEnoughData).toBe(true);
    const w = res.windows.find((x) => x.weekday === 0)!;
    expect(w).toMatchObject({ courtName: 'Court 1', startHour: 14, endHour: 18, suggestedPercent: 25, priceAmount: 20000, discountedPrice: 15000 });
    expect(w.lostMonthly).toBeGreaterThan(300_000);
    expect(w.estimatedExtraMonthly).toBeGreaterThan(0);
    expect(w.estimatedExtraMonthly).toBeLessThan(w.lostMonthly);
    expect(res.lostRevenueMonthly).toBeGreaterThanOrEqual(w.lostMonthly);
  });

  it('draws the map: busy hours are full, idle hours empty, closed hours null', async () => {
    const { svc } = build();
    const res = await svc.occupancy(owner, 'v1');
    const cells = res.courts[0].cells[0];
    expect(cells[11]).toBe(1);
    expect(cells[15]).toBe(0);
    expect(cells[3]).toBeNull();
    expect(res.openHours).toEqual({ from: 10, to: 22 });
  });

  it('says "collecting data" and suggests nothing for a venue younger than three weeks', async () => {
    const { svc } = build({ approvedAt: new Date('2026-09-20T00:00:00Z'), noBookings: true });
    const res = await svc.occupancy(owner, 'v1');
    expect(res.hasEnoughData).toBe(false);
    expect(res.windows).toEqual([]);
    expect(res.dips).toEqual([]);
  });

  it('hides a window where a discount is already running, and one dismissed within four weeks', async () => {
    const running = { courtId: 'c1', weekday: 0, startHour: 14, endHour: 16 };
    expect((await build({ discounts: [running] }).svc.occupancy(owner, 'v1')).windows.find((w) => w.weekday === 0)).toBeUndefined();
    expect((await build({ discounts: [{ ...running, startHour: 17, endHour: 18 }] }).svc.occupancy(owner, 'v1')).windows.find((w) => w.weekday === 0)).toBeUndefined();
  });

  it('never suggests without an everyday price for those hours', async () => {
    const { svc } = build({ rules: [] });
    expect((await svc.occupancy(owner, 'v1')).windows).toEqual([]);
  });

  it('a maintenance block is not read as an empty hour', async () => {
    const { svc, prisma } = build();
    prisma.calendarBlock.findMany.mockResolvedValue(SUNDAYS.map((d) => ({ courtId: 'c1', startsAt: cairo(d, '14:00'), endsAt: cairo(d, '18:00') })));
    const w = (await svc.occupancy(owner, 'v1')).windows.filter((x) => x.weekday === 0);
    expect(w).toEqual([]);
  });
});

describe('InsightsService.applyDiscount', () => {
  it('creates a time-boxed discount rule at the discounted price, above the everyday rule', async () => {
    const { svc, created, tx } = build();
    const res = await svc.applyDiscount(owner, { ...window, percent: 20, weeks: 4, source: 'suggestion' });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      courtId: 'c1', daysOfWeek: [0], startTime: '14:00', endTime: '16:00', priceAmount: 16000,
      kind: 'discount', source: 'suggestion', priority: 10, label: 'discount-20%',
    });
    expect(created[0].validFrom).toEqual(NOW);
    expect(created[0].validUntil).toEqual(new Date(NOW.getTime() + 28 * 86_400_000));
    expect(res.validUntil).toEqual(created[0].validUntil);
    const row = tx.pricingDiscount.create.mock.calls[0][0].data;
    expect(row).toMatchObject({ percent: 20, status: 'active', ruleIds: ['new-1'], createdById: 'owner-1' });
    expect(row.baselineOccupancy).toBeGreaterThanOrEqual(0);
    expect(tx.auditLogEntry.create.mock.calls[0][0].data.action).toBe('pricing.discount.applied');
  });

  it('splits at a price boundary so a peak hour keeps its peak-based discount', async () => {
    const { svc, created } = build({ rules: [rule({ endTime: '22:00' }), rule({ id: 'peak', startTime: '15:00', endTime: '22:00', priceAmount: 30000, priority: 5 })] });
    await svc.applyDiscount(owner, { ...window, endHour: 17, percent: 10, weeks: 2 });
    expect(created.map((r) => [r.startTime, r.endTime, r.priceAmount])).toEqual([
      ['14:00', '15:00', 18000],
      ['15:00', '17:00', 27000],
    ]);
  });

  it('refuses a window that already has an active discount', async () => {
    const { svc, prisma } = build();
    prisma.pricingDiscount.findFirst.mockResolvedValue({ id: 'existing' });
    await expect(svc.applyDiscount(owner, { ...window, percent: 20, weeks: 4 })).rejects.toMatchObject({ response: expect.objectContaining({ code: 'DISCOUNT_ALREADY_ACTIVE' }) });
  });

  it('refuses hours with no everyday price, and a court from another venue', async () => {
    await expect(build({ rules: [rule({ startTime: '10:00', endTime: '12:00' })] }).svc.applyDiscount(owner, { ...window, percent: 20, weeks: 4 })).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'NO_BASE_PRICE' }),
    });
    await expect(build().svc.applyDiscount(owner, { ...window, courtId: 'other', percent: 20, weeks: 4 })).rejects.toThrow('Court does not belong');
  });

  it('a window must be a real range of hours', async () => {
    await expect(build().svc.applyDiscount(owner, { ...window, startHour: 16, endHour: 16, percent: 20, weeks: 4 })).rejects.toThrow('endHour');
  });

  it('a venue that does not belong to the caller is refused', async () => {
    const stranger: AuthenticatedUser = { id: 'owner-2', phone: '', name: 'X', roles: ['owner'] };
    await expect(build().svc.applyDiscount(stranger, { ...window, percent: 20, weeks: 4 })).rejects.toThrow('Not your venue');
  });
});

describe('InsightsService end / dismiss / outcome', () => {
  it('ending early deletes the rules so the everyday price is back at once', async () => {
    const { svc, prisma } = build();
    prisma.pricingDiscount.findUnique.mockResolvedValue({ id: 'd1', venueId: 'v1', status: 'active', ruleIds: ['r1', 'r2'] });
    await svc.endDiscount(owner, 'd1');
    expect(prisma.pricingRule.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['r1', 'r2'] }, kind: 'discount' } });
    expect(prisma.pricingDiscount.update).toHaveBeenCalledWith({ where: { id: 'd1' }, data: expect.objectContaining({ status: 'ended' }) });
  });

  it('cannot end a discount that is not active', async () => {
    const { svc, prisma } = build();
    prisma.pricingDiscount.findUnique.mockResolvedValue({ id: 'd1', venueId: 'v1', status: 'ended', ruleIds: [] });
    await expect(svc.endDiscount(owner, 'd1')).rejects.toThrow('not active');
  });

  it('dismissing hides the suggestion for four weeks', async () => {
    const { svc, prisma } = build();
    await svc.dismiss(owner, window);
    const data = prisma.pricingDiscount.create.mock.calls[0][0].data;
    expect(data.status).toBe('dismissed');
    expect(data.dismissedUntil).toEqual(new Date(NOW.getTime() + 28 * 86_400_000));
  });

  it('measures the result once the discount has run two weeks: occupancy before vs after', async () => {
    const applied = new Date('2026-09-06T00:00:00Z');
    // After it started, every Sunday 14–16 is fully booked; before it was empty.
    const filled = ['2026-09-06', '2026-09-13', '2026-09-20', '2026-09-27'].map((d) => ({ courtId: 'c1', slotStart: cairo(d, '14:00'), slotEnd: cairo(d, '16:00') }));
    const { svc, prisma } = build({ extraBookings: filled });
    prisma.pricingDiscount.findMany.mockResolvedValue([
      { id: 'd1', venueId: 'v1', courtId: 'c1', weekday: 0, startHour: 14, endHour: 16, percent: 20, status: 'active', source: 'suggestion', validFrom: applied, validUntil: new Date('2026-10-04T00:00:00Z'), baselineOccupancy: 0, ruleIds: ['r1'], createdAt: applied },
    ]);
    const { items } = await svc.listDiscounts(owner, 'v1');
    expect(items[0]).toMatchObject({ measured: true, currentOccupancy: 1, baselineOccupancy: 0, status: 'active' });
    // 4 Sundays measured × 2 hours × (1 − 0) = 8 extra booked hours at 150 EGP
    expect(items[0].extraBookedHours).toBe(8);
    expect(items[0].extraRevenue).toBe(120000);
  });

  it('does not claim a result before two weeks have passed', async () => {
    const { svc, prisma } = build();
    const started = new Date(NOW.getTime() - 5 * 86_400_000);
    prisma.pricingDiscount.findMany.mockResolvedValue([
      { id: 'd1', venueId: 'v1', courtId: 'c1', weekday: 0, startHour: 14, endHour: 16, percent: 20, status: 'active', source: 'manual', validFrom: started, validUntil: new Date(NOW.getTime() + 23 * 86_400_000), baselineOccupancy: 0.1, ruleIds: [], createdAt: started },
    ]);
    const { items } = await svc.listDiscounts(owner, 'v1');
    expect(items[0]).toMatchObject({ measured: false, currentOccupancy: null, extraRevenue: null });
  });

  it('a finished discount reads as ended', async () => {
    const { svc, prisma } = build();
    prisma.pricingDiscount.findMany.mockResolvedValue([
      { id: 'd1', venueId: 'v1', courtId: 'c1', weekday: 0, startHour: 14, endHour: 16, percent: 20, status: 'active', source: 'manual', validFrom: new Date('2026-08-01T00:00:00Z'), validUntil: new Date('2026-08-29T00:00:00Z'), baselineOccupancy: 0.1, ruleIds: [], createdAt: new Date('2026-08-01T00:00:00Z') },
    ]);
    expect((await svc.listDiscounts(owner, 'v1')).items[0]).toMatchObject({ status: 'ended', daysLeft: 0 });
  });
});
