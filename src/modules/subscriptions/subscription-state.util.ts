export type SubscriptionState = 'active' | 'expiring' | 'grace' | 'overdue';

export const DAY_MS = 86_400_000;
export const EXPIRING_SOON_DAYS = 7;

export interface SubscriptionStanding {
  state: SubscriptionState;
  daysLeft: number;
  graceEndsAt: Date;
  graceDaysLeft: number;
}

export function subscriptionStanding(
  input: { currentPeriodEnd: Date; graceDays: number },
  now: Date = new Date(),
): SubscriptionStanding {
  const end = input.currentPeriodEnd.getTime();
  const graceEnd = end + input.graceDays * DAY_MS;
  const t = now.getTime();
  const daysLeft = Math.ceil((end - t) / DAY_MS) || 0;
  let state: SubscriptionState;
  if (t <= end) state = daysLeft <= EXPIRING_SOON_DAYS ? 'expiring' : 'active';
  else if (t <= graceEnd) state = 'grace';
  else state = 'overdue';
  return {
    state,
    daysLeft,
    graceEndsAt: new Date(graceEnd),
    graceDaysLeft: Math.max(0, Math.min(input.graceDays, Math.ceil((graceEnd - t) / DAY_MS))),
  };
}

export function extendedPeriodEnd(currentEnd: Date, days: number, now: Date = new Date()): Date {
  const base = currentEnd.getTime() > now.getTime() ? currentEnd.getTime() : now.getTime();
  return new Date(base + days * DAY_MS);
}
