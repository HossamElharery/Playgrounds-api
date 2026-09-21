/**
 * Where a venue's manual subscription stands. Pure so the admin list, the owner card
 * and the morning job can never disagree.
 *
 *   active    more than 7 days left
 *   expiring  7 days or fewer left
 *   grace     ended, still inside the grace window (the venue keeps working)
 *   overdue   past the grace window (the venue STILL keeps working — nothing is enforced yet)
 */
export type SubscriptionState = 'active' | 'expiring' | 'grace' | 'overdue';

export const DAY_MS = 86_400_000;
export const EXPIRING_SOON_DAYS = 7;

export interface SubscriptionStanding {
  state: SubscriptionState;
  /** Whole days until the period ends (negative = days since it ended). */
  daysLeft: number;
  graceEndsAt: Date;
  /** Whole days of grace left; 0 once the window is over. */
  graceDaysLeft: number;
}

export function subscriptionStanding(
  input: { currentPeriodEnd: Date; graceDays: number },
  now: Date = new Date(),
): SubscriptionStanding {
  const end = input.currentPeriodEnd.getTime();
  const graceEnd = end + input.graceDays * DAY_MS;
  const t = now.getTime();
  // Whole days; once the period is over this counts days since it ended, as a negative number.
  const daysLeft = Math.ceil((end - t) / DAY_MS) || 0;
  let state: SubscriptionState;
  if (t <= end) state = daysLeft <= EXPIRING_SOON_DAYS ? 'expiring' : 'active';
  else if (t <= graceEnd) state = 'grace';
  else state = 'overdue';
  return {
    state,
    daysLeft,
    graceEndsAt: new Date(graceEnd),
    // Only meaningful once the period ended; while it is still running the whole window is ahead.
    graceDaysLeft: Math.max(0, Math.min(input.graceDays, Math.ceil((graceEnd - t) / DAY_MS))),
  };
}

/** New period end after a payment: renew from the current end while it is still ahead, else from today. */
export function extendedPeriodEnd(currentEnd: Date, days: number, now: Date = new Date()): Date {
  const base = currentEnd.getTime() > now.getTime() ? currentEnd.getTime() : now.getTime();
  return new Date(base + days * DAY_MS);
}
