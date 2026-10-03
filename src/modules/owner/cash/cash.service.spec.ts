import { CashService, reconcile, tally } from './cash.service';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.interface';

const owner: AuthenticatedUser = { id: 'owner-1', phone: '', name: 'المالك', roles: ['owner'] };
const staff: AuthenticatedUser = { id: 'staff-1', phone: '', name: 'أحمد', roles: ['staff'] };
const venue = { id: 'v1', ownerId: 'owner-1', nameAr: 'ملعب', nameEn: 'Venue', currency: 'EGP' };

const at = (h: number) => new Date(`2026-10-02T${String(h).padStart(2, '0')}:00:00.000Z`);
const pay = (id: string, amount: number, method = 'cash', by = 'staff-1', h = 10) => ({
  id,
  amount,
  currency: 'EGP',
  method,
  createdAt: at(h),
  recordedByUserId: by,
});

describe('tally / reconcile (pure)', () => {
  it('adds each method up and keeps refunds and drawer expenses out of the cash in', () => {
    const t = tally(
      [pay('p1', 300), pay('p2', 100, 'instapay'), pay('p3', -50), pay('p4', 200, 'cash', 'staff-1', 9)],
      [{ id: 'e1', amount: 40, currency: 'EGP', createdAt: at(11), createdById: 'staff-1' }],
    );
    expect(t.cashIn).toBe(500);
    expect(t.cashRefunds).toBe(50);
    expect(t.cashExpenses).toBe(40);
    expect(t.cashNet).toBe(410);
    expect(t.byMethod.find((m) => m.method === 'instapay')).toMatchObject({ in: 100, out: 0, count: 1 });
    expect(t.byMethod.find((m) => m.method === 'cash')).toMatchObject({ in: 500, out: 50, count: 2 });
    expect(t.since?.toISOString()).toBe(at(9).toISOString());
    expect(t.count).toBe(5);
  });

  it('expected = starting float + cash in − refunds − drawer expenses; difference is counted − expected', () => {
    expect(reconcile({ openingFloat: 1000, cashNet: 410, countedCash: 1400 })).toEqual({ expectedCash: 1410, difference: -10 });
    expect(reconcile({ openingFloat: 0, cashNet: 410, countedCash: 450 })).toEqual({ expectedCash: 410, difference: 40 });
    expect(reconcile({ openingFloat: 0, cashNet: 0, countedCash: 0 }).difference).toBe(0);
  });
});

function setup(opts: { payments?: ReturnType<typeof pay>[]; expenses?: unknown[]; lastCarry?: number; staffPerms?: string[]; stampedPayments?: number; openHandover?: Record<string, unknown> | null } = {}) {
  const payments = opts.payments ?? [pay('p1', 300), pay('p2', 150)];
  const expenses = opts.expenses ?? [];
  const tx = {
    payment: {
      findMany: jest.fn().mockResolvedValue(payments),
      updateMany: jest.fn().mockResolvedValue({ count: opts.stampedPayments ?? payments.length }),
    },
    venueExpense: {
      findMany: jest.fn().mockResolvedValue(expenses),
      updateMany: jest.fn().mockResolvedValue({ count: expenses.length }),
    },
    cashShift: {
      findFirst: jest.fn().mockResolvedValue(opts.lastCarry != null ? { carryOver: opts.lastCarry, closedAt: at(1) } : null),
      create: jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'shift-1',
        closedAt: at(12),
        reviewedAt: null,
        reviewedById: null,
        reviewNote: null,
        ...data,
      })),
    },
    cashHandover: {
      findFirst: jest.fn().mockResolvedValue(opts.openHandover ?? null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'h-1', openedAt: at(8), shiftId: null, note: null, ...data })),
      update: jest.fn().mockResolvedValue({}),
    },
    auditLogEntry: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    cashHandover: tx.cashHandover,
    venue: { findUnique: jest.fn().mockResolvedValue(venue) },
    staffMember: {
      findUnique: jest.fn().mockResolvedValue({ id: 'st', ownerId: 'owner-1', permissions: opts.staffPerms ?? ['bookings.view', 'payments.record'], venueIds: ['v1'], title: null }),
    },
    user: { findMany: jest.fn().mockResolvedValue([{ id: 'staff-1', name: 'أحمد' }, { id: 'owner-1', name: 'المالك' }]) },
    $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const notifications = { create: jest.fn().mockResolvedValue(null) };
  return { tx, prisma, notifications, service: new CashService(prisma as never, notifications as never) };
}

describe('CashService.closeShift', () => {
  it('closes my own drawer: expected includes the float, every counted payment is stamped with the shift', async () => {
    const { service, tx } = setup({ lastCarry: 200 });
    const shift = await service.closeShift(staff, { venueId: 'v1', scope: 'mine', countedCash: 640, carryOver: 100 });
    // float 200 (what the last close left) + 450 cash in = 650 expected; counted 640 → 10 short.
    expect(shift.openingFloat).toBe(200);
    expect(shift.expectedCash).toBe(650);
    expect(shift.difference).toBe(-10);
    expect(shift.carryOver).toBe(100);
    expect(shift.handedOver).toBe(540);
    expect(tx.payment.updateMany).toHaveBeenCalledWith({ where: { id: { in: ['p1', 'p2'] }, shiftId: null }, data: { shiftId: 'shift-1' } });
    // Only my payments are read.
    expect(tx.payment.findMany.mock.calls[0][0].where.recordedByUserId).toEqual({ in: ['staff-1'] });
  });

  it('lets the closer correct the starting float', async () => {
    const { service } = setup({ lastCarry: 200 });
    const shift = await service.closeShift(staff, { venueId: 'v1', scope: 'mine', countedCash: 450, openingFloat: 0 });
    expect(shift.openingFloat).toBe(0);
    expect(shift.difference).toBe(0);
  });

  it('subtracts a cash expense paid out of the drawer', async () => {
    const { service } = setup({ expenses: [{ id: 'e1', amount: 50, currency: 'EGP', createdAt: at(11), createdById: 'staff-1' }] });
    const shift = await service.closeShift(staff, { venueId: 'v1', scope: 'mine', countedCash: 400 });
    expect(shift.cashExpenses).toBe(50);
    expect(shift.expectedCash).toBe(400);
    expect(shift.difference).toBe(0);
  });

  it('refuses to close a drawer that holds money in another currency than the venue\'s', async () => {
    const mixed = { ...pay('p2', 150), currency: 'AED' };
    const { service, tx } = setup({ payments: [pay('p1', 300), mixed] });
    await expect(service.closeShift(staff, { venueId: 'v1', scope: 'mine', countedCash: 450 })).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'MIXED_CURRENCY' }),
    });
    expect(tx.cashShift.create).not.toHaveBeenCalled();
  });

  it('refuses to close an empty drawer', async () => {
    const { service } = setup({ payments: [] });
    await expect(service.closeShift(staff, { venueId: 'v1', scope: 'mine', countedCash: 0 })).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'NOTHING_TO_CLOSE' }),
    });
  });

  it('cannot leave more in the drawer than was counted', async () => {
    const { service } = setup();
    await expect(service.closeShift(staff, { venueId: 'v1', scope: 'mine', countedCash: 100, carryOver: 500 })).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'CARRY_OVER_TOO_HIGH' }),
    });
  });

  it('aborts rather than miscount when the drawer changed underneath', async () => {
    const { service } = setup({ stampedPayments: 1 });
    await expect(service.closeShift(staff, { venueId: 'v1', scope: 'mine', countedCash: 450 })).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'DRAWER_CHANGED' }),
    });
  });

  it('a reception account cannot close a colleague\'s drawer or the shared one', async () => {
    const { service } = setup();
    await expect(service.closeShift(staff, { venueId: 'v1', scope: 'user', targetUserId: 'someone-else', countedCash: 1 })).rejects.toThrow('only close your own');
    await expect(service.closeShift(staff, { venueId: 'v1', scope: 'shared', countedCash: 1 })).rejects.toThrow('shared drawer');
  });

  it('the owner can close one person\'s drawer, or one shared drawer over everybody\'s cash', async () => {
    const one = setup();
    const personal = await one.service.closeShift(owner, { venueId: 'v1', scope: 'user', targetUserId: 'staff-1', countedCash: 450 });
    expect(personal.scope).toBe('person');
    expect(personal.drawerUserId).toBe('staff-1');
    expect(personal.closedByUserId).toBe('owner-1');
    expect(one.tx.payment.findMany.mock.calls[0][0].where.recordedByUserId).toEqual({ in: ['staff-1'] });

    const shared = setup({ payments: [pay('p1', 300), pay('p9', 200, 'cash', 'staff-2')] });
    const all = await shared.service.closeShift(owner, { venueId: 'v1', scope: 'shared', countedCash: 500 });
    expect(all.scope).toBe('shared');
    expect(all.drawerUserId).toBeNull();
    expect(shared.tx.payment.findMany.mock.calls[0][0].where.recordedByUserId).toEqual({ not: null });
  });

  it('a staff account holding shifts.review may close for others', async () => {
    const { service } = setup({ staffPerms: ['bookings.view', 'payments.record', 'reports.view', 'shifts.review'] });
    const shift = await service.closeShift(staff, { venueId: 'v1', scope: 'shared', countedCash: 450 });
    expect(shift.scope).toBe('shared');
  });

  it('tells the owner when a staff close is off, and stays quiet when it balances or the owner closes', async () => {
    const off = setup();
    await off.service.closeShift(staff, { venueId: 'v1', scope: 'mine', countedCash: 400 });
    expect(off.notifications.create).toHaveBeenCalledWith(expect.objectContaining({ userId: 'owner-1', titleAr: expect.stringContaining('ناقصة') }));
    // 50 minor units is half a pound — written with the venue's currency label, not "50 EGP".
    const sent = off.notifications.create.mock.calls[0][0];
    expect(sent.titleAr).toContain('0.5 ج.م');
    expect(sent.titleAr).not.toContain('EGP');
    expect(sent.titleEn).toContain('0.5 EGP');

    const balanced = setup();
    await balanced.service.closeShift(staff, { venueId: 'v1', scope: 'mine', countedCash: 450 });
    expect(balanced.notifications.create).not.toHaveBeenCalled();

    const own = setup();
    await own.service.closeShift(owner, { venueId: 'v1', scope: 'mine', countedCash: 100 });
    expect(own.notifications.create).not.toHaveBeenCalled();
  });
});

describe('CashService.openShift — a documented handover', () => {
  it('records what the incoming person counted against what the last close left, and tells the owner of a gap', async () => {
    const { service, tx, notifications } = setup({ lastCarry: 200 });
    const out = await service.openShift(staff, { venueId: 'v1', scope: 'mine', countedFloat: 150 });
    expect(tx.cashHandover.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ drawerUserId: 'staff-1', openedByUserId: 'staff-1', expectedFloat: 200, countedFloat: 150, difference: -50, currency: 'EGP' }),
    });
    expect(out).toMatchObject({ expectedFloat: 200, countedFloat: 150, difference: -50 });
    expect(notifications.create).toHaveBeenCalledWith(expect.objectContaining({ userId: 'owner-1', deepLink: '/owner/earnings?section=shifts' }));
  });

  it('stays quiet when the count matches the last close', async () => {
    const { service, notifications } = setup({ lastCarry: 200 });
    await service.openShift(staff, { venueId: 'v1', scope: 'mine', countedFloat: 200 });
    expect(notifications.create).not.toHaveBeenCalled();
  });

  it('refuses to open a drawer that is already open', async () => {
    const { service } = setup({ openHandover: { id: 'h0', countedFloat: 100, openedAt: at(8), shiftId: null } });
    await expect(service.openShift(staff, { venueId: 'v1', scope: 'mine', countedFloat: 100 })).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'SHIFT_ALREADY_OPEN' }),
    });
  });

  it('reception cannot take over a colleague\'s drawer', async () => {
    const { service } = setup();
    await expect(service.openShift(staff, { venueId: 'v1', scope: 'user', targetUserId: 'someone-else', countedFloat: 0 })).rejects.toThrow('only open your own');
  });

  it('the closing shift starts from the counted float, begins at the handover and links it', async () => {
    const { service, tx } = setup({ lastCarry: 200, openHandover: { id: 'h0', countedFloat: 150, openedAt: at(8), shiftId: null } });
    const shift = await service.closeShift(staff, { venueId: 'v1', scope: 'mine', countedCash: 600 });
    // 150 counted at takeover + 450 cash in = 600 expected → balanced, though the last close said 200.
    expect(shift.openingFloat).toBe(150);
    expect(shift.expectedCash).toBe(600);
    expect(shift.difference).toBe(0);
    expect(tx.cashShift.create.mock.calls[0][0].data.periodStart).toEqual(at(8));
    expect(tx.cashHandover.update).toHaveBeenCalledWith({ where: { id: 'h0' }, data: { shiftId: 'shift-1' } });
  });

  it('an opened drawer with no movements can still be closed — the handover is the record', async () => {
    const { service } = setup({ payments: [], openHandover: { id: 'h0', countedFloat: 100, openedAt: at(8), shiftId: null } });
    const shift = await service.closeShift(staff, { venueId: 'v1', scope: 'mine', countedCash: 100 });
    expect(shift.difference).toBe(0);
  });
});
