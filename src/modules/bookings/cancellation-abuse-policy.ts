const DAY_MS = 86_400_000;

export interface BookingRestrictionDecision {
  level: 1 | 2;
  until: Date;
}

/**
 * Progressive, booking-only protection. The caller supplies counts that
 * include the cancellation which just succeeded.
 */
export function cancellationRestriction(
  count24h: number,
  count30d: number,
  now: Date,
): BookingRestrictionDecision | null {
  if (count24h < 3) return null;
  const level = count30d >= 5 ? 2 : 1;
  return { level, until: new Date(now.getTime() + (level === 2 ? 7 * DAY_MS : DAY_MS)) };
}
