import { SubscriptionsService } from './subscriptions.service';
import { DAY_MS } from './subscription-state.util';

const now = new Date('2026-09-21T09:00:00.000Z');
const at = (days: number) => new Date(now.getTime() + days * DAY_MS);
const admin = { id: 'admin-1', phone: '', name: 'Admin', roles: ['admin'] } as never;

function sub(over: Record<string, unknown> = {}) {
  return {
    id: 'sub1',
    venueId: 'v1',
    planKey: 'pro',
    listPriceAmount: 300000,
    agreedPriceAmount: 200000,
    currency: 'EGP',
    startedAt: at(-60),
    currentPeriodEnd: at(3),
    graceDays: 14,
    notes: null,
    lastNoticeDate: null,
    venue: { id: 'v1', ownerId: 'owner-1', nameEn: 'Arena', nameAr: 'الساحة', country: { timezone: 'Africa/Cairo' } },
    ...over,
  };
}

function build(subs: any[]) {
  const tx: any = {
    venueSubscription: { update: jest.fn().mockResolvedValue({}) },
    subscriptionPayment: { create: jest.fn().mockResolvedValue({}) },
    auditLogEntry: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma: any = {
    ...tx,
    venueSubscription: {
      ...tx.venueSubscription,
      findMany: jest.fn().mockResolvedValue(subs),
      findUnique: jest.fn().mockResolvedValue(subs[0]),
    },
    venue: {
      findUnique: jest.fn().mockResolvedValue({ id: 'v1', nameEn: 'Arena', nameAr: 'الساحة' }),
      findUniqueOrThrow: jest.fn().mockResolvedValue(subs[0]?.venue),
    },
    subscriptionPayment: { ...tx.subscriptionPayment, findMany: jest.fn().mockResolvedValue([]) },
    user: { findMany: jest.fn().mockResolvedValue([{ id: 'admin-1' }]) },
    notification: { findFirst: jest.fn().mockResolvedValue(null) },
    $transaction: jest.fn(async (fn: any) => (typeof fn === 'function' ? fn(tx) : Promise.all(fn))),
  };
  const notifications = { create: jest.fn().mockResolvedValue(null) };
  return { svc: new SubscriptionsService(prisma, notifications as never), prisma, tx, notifications };
}

describe('SubscriptionsService', () => {
  it('extend: adds the days from the current end, records who took what, and tells the owner', async () => {
    const { svc, tx, notifications } = build([sub({ currentPeriodEnd: at(10) })]);
    await svc.extend(admin, 'v1', { days: 90, amount: 200000, method: 'instapay', note: 'paid in full' });
    const update = tx.venueSubscription.update.mock.calls[0][0].data;
    expect(update.currentPeriodEnd.getTime()).toBe(at(100).getTime());
    expect(update.lastNoticeDate).toBeNull();
    expect(tx.subscriptionPayment.create.mock.calls[0][0].data).toMatchObject({ amount: 200000, daysAdded: 90, method: 'instapay', recordedById: 'admin-1' });
    expect(tx.auditLogEntry.create.mock.calls[0][0].data.action).toBe('subscription.extended');
    expect(notifications.create).toHaveBeenCalledWith(expect.objectContaining({ userId: 'owner-1', deepLink: '/owner/settings' }));
  });

  it('the owner view shows the struck-through list price and never the agreed one', async () => {
    const { svc, prisma } = build([sub()]);
    prisma.venue.findUnique.mockResolvedValue({ id: 'v1', ownerId: 'owner-1' });
    // forOwner reads the real clock; pin it to the fixture's `now` so the
    // 3-days-left subscription stays "expiring" whatever day the suite runs.
    jest.useFakeTimers({ now, doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    const view = await svc
      .forOwner({ id: 'owner-1', phone: '', name: 'O', roles: ['owner'] } as never, 'v1')
      .finally(() => jest.useRealTimers());
    expect(view).toMatchObject({ listPriceAmount: 300000, isFree: true, state: 'expiring' });
    expect(JSON.stringify(view)).not.toContain('agreedPrice');
    expect(JSON.stringify(view)).not.toContain('200000');
  });

  describe('morning reminders', () => {
    it('warns at 7/3/1 days but stays quiet in between', async () => {
      for (const [days, expected] of [[7, 1], [5, 0], [3, 1], [2, 0], [1, 1]] as const) {
        const { svc, notifications } = build([sub({ currentPeriodEnd: at(days - 0.4) })]);
        const res = await svc.sendDailyReminders(now);
        expect({ days, sent: res.owners }).toEqual({ days, sent: expected });
        expect(notifications.create.mock.calls.filter((c) => c[0].userId === 'owner-1')).toHaveLength(expected);
      }
    });

    it('nags EVERY morning once it has ended (grace, then overdue) but never blocks anything', async () => {
      const grace = build([sub({ currentPeriodEnd: at(-3) })]);
      await grace.svc.sendDailyReminders(now);
      expect(grace.notifications.create).toHaveBeenCalledWith(expect.objectContaining({ userId: 'owner-1', titleAr: expect.stringContaining('سماح') }));
      const overdue = build([sub({ currentPeriodEnd: at(-40) })]);
      await overdue.svc.sendDailyReminders(now);
      expect(overdue.notifications.create).toHaveBeenCalledWith(expect.objectContaining({ userId: 'owner-1', titleEn: 'Your plan is overdue' }));
    });

    it('sends at most one owner notice per day', async () => {
      const { svc, notifications } = build([sub({ currentPeriodEnd: at(-3), lastNoticeDate: '2026-09-21' })]);
      const res = await svc.sendDailyReminders(now);
      expect(res.owners).toBe(0);
      expect(notifications.create.mock.calls.filter((c) => c[0].userId === 'owner-1')).toHaveLength(0);
    });

    it('gives the admin one digest, and not a second one the same day', async () => {
      const first = build([sub({ currentPeriodEnd: at(-3) })]);
      expect((await first.svc.sendDailyReminders(now)).admins).toBe(1);
      expect(first.notifications.create).toHaveBeenCalledWith(expect.objectContaining({ userId: 'admin-1', deepLink: '/admin/subscriptions' }));
      const again = build([sub({ currentPeriodEnd: at(-3) })]);
      again.prisma.notification.findFirst.mockResolvedValue({ id: 'n' });
      expect((await again.svc.sendDailyReminders(now)).admins).toBe(0);
    });

    it('a healthy subscription produces no noise', async () => {
      const { svc, notifications } = build([]);
      expect(await svc.sendDailyReminders(now)).toEqual({ owners: 0, admins: 0 });
      expect(notifications.create).not.toHaveBeenCalled();
    });
  });
});
