export const SQUAD_INVITE_HOLD_MS = 5 * 60 * 1000;
export const SQUAD_INVITE_PAUSED_CODE = 'SQUAD_INVITE_PAUSED';

export function squadInviteHoldUntil(now = Date.now()): Date {
  return new Date(now + SQUAD_INVITE_HOLD_MS);
}

export function squadInviteRetryAfterSec(until: Date, now = Date.now()): number {
  return Math.max(1, Math.ceil((until.getTime() - now) / 1000));
}
