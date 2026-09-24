import {
  evaluateQuota,
  policyFromEnv,
  quotaDayBounds,
} from './morph-quota.util';

const daily2 = policyFromEnv('2');

describe('morph quota', () => {
  it('reads the policy from env (unset/empty/invalid = unlimited)', () => {
    expect(policyFromEnv(undefined)).toEqual({ kind: 'unlimited' });
    expect(policyFromEnv('')).toEqual({ kind: 'unlimited' });
    expect(policyFromEnv('0')).toEqual({ kind: 'unlimited' });
    expect(policyFromEnv('abc')).toEqual({ kind: 'unlimited' });
    expect(daily2).toEqual({
      kind: 'daily',
      freePerDay: 2,
      timeZone: 'Africa/Cairo',
    });
  });

  it('unlimited always allows and reports no counts', () => {
    const q = evaluateQuota({ kind: 'unlimited' }, 500, 0, new Date());
    expect(q).toEqual({
      allowed: true,
      source: 'FREE',
      remainingFree: null,
      bonusRolls: 0,
      resetsAt: null,
    });
  });

  it('daily=2 allows two free rolls then blocks', () => {
    const now = new Date('2026-01-15T10:00:00Z');
    expect(evaluateQuota(daily2, 0, 0, now)).toMatchObject({
      allowed: true,
      source: 'FREE',
      remainingFree: 2,
    });
    expect(evaluateQuota(daily2, 1, 0, now)).toMatchObject({
      allowed: true,
      source: 'FREE',
      remainingFree: 1,
    });
    expect(evaluateQuota(daily2, 2, 0, now)).toMatchObject({
      allowed: false,
      source: null,
      remainingFree: 0,
    });
  });

  it('consumes BONUS only after FREE is exhausted', () => {
    const now = new Date('2026-01-15T10:00:00Z');
    expect(evaluateQuota(daily2, 1, 3, now).source).toBe('FREE');
    expect(evaluateQuota(daily2, 2, 3, now)).toMatchObject({
      allowed: true,
      source: 'BONUS',
      bonusRolls: 3,
    });
    expect(evaluateQuota(daily2, 2, 0, now).allowed).toBe(false);
  });

  it('resets at Cairo midnight, not UTC (EET, winter: UTC+2)', () => {
    // 21:59Z = 23:59 Cairo (still Jan 15); 22:01Z = 00:01 Cairo (Jan 16).
    const before = quotaDayBounds(
      new Date('2026-01-15T21:59:00Z'),
      'Africa/Cairo',
    );
    const after = quotaDayBounds(
      new Date('2026-01-15T22:01:00Z'),
      'Africa/Cairo',
    );
    expect(before.start.toISOString()).toBe('2026-01-14T22:00:00.000Z');
    expect(before.end.toISOString()).toBe('2026-01-15T22:00:00.000Z');
    expect(after.start.toISOString()).toBe('2026-01-15T22:00:00.000Z');
    expect(
      evaluateQuota(daily2, 2, 0, new Date('2026-01-15T21:59:00Z')).resetsAt,
    ).toBe('2026-01-15T22:00:00.000Z');
  });

  it('resets at Cairo midnight during EEST (summer: UTC+3)', () => {
    // 20:59Z = 23:59 Cairo; 21:01Z = 00:01 Cairo next day.
    const before = quotaDayBounds(
      new Date('2026-07-15T20:59:00Z'),
      'Africa/Cairo',
    );
    const after = quotaDayBounds(
      new Date('2026-07-15T21:01:00Z'),
      'Africa/Cairo',
    );
    expect(before.end.toISOString()).toBe('2026-07-15T21:00:00.000Z');
    expect(after.start.toISOString()).toBe('2026-07-15T21:00:00.000Z');
    // 21:59Z vs 22:01Z in summer are both the same Cairo day (00:59 / 01:01).
    const a = quotaDayBounds(new Date('2026-07-15T21:59:00Z'), 'Africa/Cairo');
    const b = quotaDayBounds(new Date('2026-07-15T22:01:00Z'), 'Africa/Cairo');
    expect(a.start.getTime()).toBe(b.start.getTime());
  });
});
