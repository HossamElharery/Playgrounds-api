import { DAY_MS, extendedPeriodEnd, subscriptionStanding } from './subscription-state.util';

const now = new Date('2026-09-21T09:00:00.000Z');
const at = (days: number) => new Date(now.getTime() + days * DAY_MS);

describe('subscriptionStanding', () => {
  it('is active with more than a week left', () => {
    expect(subscriptionStanding({ currentPeriodEnd: at(30), graceDays: 14 }, now)).toMatchObject({ state: 'active', daysLeft: 30 });
  });

  it('is expiring inside the last 7 days, including the last day', () => {
    expect(subscriptionStanding({ currentPeriodEnd: at(7), graceDays: 14 }, now).state).toBe('expiring');
    expect(subscriptionStanding({ currentPeriodEnd: at(0.5), graceDays: 14 }, now)).toMatchObject({ state: 'expiring', daysLeft: 1 });
  });

  it('enters grace the moment the period ends, then counts the grace days down', () => {
    const s = subscriptionStanding({ currentPeriodEnd: at(-2), graceDays: 14 }, now);
    expect(s).toMatchObject({ state: 'grace', graceDaysLeft: 12 });
    expect(s.daysLeft).toBeLessThan(0);
  });

  it('is overdue once the grace window has passed', () => {
    expect(subscriptionStanding({ currentPeriodEnd: at(-15), graceDays: 14 }, now)).toMatchObject({ state: 'overdue', graceDaysLeft: 0 });
  });

  it('a zero-day grace goes straight to overdue', () => {
    expect(subscriptionStanding({ currentPeriodEnd: at(-1), graceDays: 0 }, now).state).toBe('overdue');
  });
});

describe('extendedPeriodEnd', () => {
  it('renews from the current end while it is still ahead, so no paid days are lost', () => {
    expect(extendedPeriodEnd(at(10), 30, now).getTime()).toBe(at(40).getTime());
  });

  it('restarts from today when the plan already lapsed', () => {
    expect(extendedPeriodEnd(at(-40), 90, now).getTime()).toBe(at(90).getTime());
  });
});
