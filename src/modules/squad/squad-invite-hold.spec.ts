import {
  SQUAD_INVITE_HOLD_MS,
  squadInviteHoldUntil,
  squadInviteRetryAfterSec,
} from './squad-invite-hold';

describe('squad invite hold', () => {
  it('pauses the sender for five minutes', () => {
    const now = Date.parse('2026-09-18T12:00:00.000Z');
    expect(squadInviteHoldUntil(now).getTime()).toBe(now + SQUAD_INVITE_HOLD_MS);
    expect(SQUAD_INVITE_HOLD_MS).toBe(5 * 60 * 1000);
  });

  it('reports remaining seconds without going below one while still active', () => {
    const until = new Date('2026-09-18T12:05:00.000Z');
    expect(squadInviteRetryAfterSec(until, Date.parse('2026-09-18T12:04:01.000Z'))).toBe(59);
    expect(squadInviteRetryAfterSec(until, Date.parse('2026-09-18T12:05:00.000Z'))).toBe(1);
  });
});
