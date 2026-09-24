import { zonedDayBounds } from '../../common/utils/timezone.util';

export const MORPH_QUOTA_TIME_ZONE = 'Africa/Cairo';

export type MorphRollPolicy =
  | { kind: 'unlimited' }
  | { kind: 'daily'; freePerDay: number; timeZone: string };

export interface QuotaState {
  allowed: boolean;
  /** Which bucket this roll would consume. */
  source: 'FREE' | 'BONUS' | null;
  /** null = unlimited. */
  remainingFree: number | null;
  bonusRolls: number;
  /** ISO, next local midnight for 'daily'. */
  resetsAt: string | null;
}

/** `MORPH_DAILY_FREE_ROLLS`: empty/unset/invalid → unlimited (today's behavior). */
export function policyFromEnv(raw: string | undefined | null): MorphRollPolicy {
  const trimmed = (raw ?? '').trim();
  if (!/^\d+$/.test(trimmed)) return { kind: 'unlimited' };
  const freePerDay = Number(trimmed);
  if (freePerDay <= 0) return { kind: 'unlimited' };
  return { kind: 'daily', freePerDay, timeZone: MORPH_QUOTA_TIME_ZONE };
}

/** Local calendar date (YYYY-MM-DD) of `instant` in `timeZone`. */
export function zonedDateString(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

/** [start, end) of the local day containing `now`. */
export function quotaDayBounds(
  now: Date,
  timeZone: string,
): { start: Date; end: Date } {
  const { start, end } = zonedDayBounds(
    zonedDateString(now, timeZone),
    timeZone,
  );
  return { start, end };
}

export function evaluateQuota(
  policy: MorphRollPolicy,
  freeRollsToday: number,
  bonusRolls: number,
  now: Date,
): QuotaState {
  if (policy.kind === 'unlimited') {
    return {
      allowed: true,
      source: 'FREE',
      remainingFree: null,
      bonusRolls,
      resetsAt: null,
    };
  }
  const remainingFree = Math.max(0, policy.freePerDay - freeRollsToday);
  const resetsAt = quotaDayBounds(now, policy.timeZone).end.toISOString();
  if (remainingFree > 0) {
    return {
      allowed: true,
      source: 'FREE',
      remainingFree,
      bonusRolls,
      resetsAt,
    };
  }
  if (bonusRolls > 0) {
    return {
      allowed: true,
      source: 'BONUS',
      remainingFree: 0,
      bonusRolls,
      resetsAt,
    };
  }
  return {
    allowed: false,
    source: null,
    remainingFree: 0,
    bonusRolls,
    resetsAt,
  };
}
