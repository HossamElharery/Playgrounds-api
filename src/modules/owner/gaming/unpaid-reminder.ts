/** How long after a session ends the team is first reminded that its bill is still unpaid. */
export const UNPAID_FIRST_MS = 3 * 60_000;
/** Reminders stop for bills older than this (the shift is over; the unpaid list still shows them). */
export const UNPAID_WINDOW_MS = 12 * 3_600_000;

/**
 * Which reminder a bill is on, by minutes since its session ended: every 5 minutes for the first half hour
 * (from minute 3), then every 30 minutes. `null` means too early. A new number means a new notification.
 */
export function unpaidReminderSlot(minutesSinceEnd: number): number | null {
  if (!Number.isFinite(minutesSinceEnd) || minutesSinceEnd < UNPAID_FIRST_MS / 60_000) return null;
  if (minutesSinceEnd < 30) return Math.floor((minutesSinceEnd - 3) / 5);
  return 6 + Math.floor((minutesSinceEnd - 30) / 30);
}
