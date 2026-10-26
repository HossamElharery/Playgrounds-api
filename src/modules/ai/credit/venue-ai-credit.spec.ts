import {
  CREDIT_WINDOW_DAYS,
  creditView,
  dueWindow,
  freshAiCycle,
  ownerCreditDto,
  planCreditSetting,
  type CreditRow,
} from './venue-ai-credit';

const DAY = 86_400_000;
const NOW = new Date('2026-11-10T12:00:00Z');
const facts = { planUsd: 4, trialUsd: 0.5 };

const row = (over: Partial<CreditRow> = {}): CreditRow => ({
  venueId: 'v1',
  planKey: 'pro',
  currentPeriodEnd: new Date(NOW.getTime() + 20 * DAY),
  graceDays: 14,
  aiAssistantEnabled: true,
  aiCreditOverrideUsd: null,
  aiTrial: false,
  aiCycleStartedAt: new Date(NOW.getTime() - 5 * DAY),
  aiCycleEndsAt: new Date(NOW.getTime() + 25 * DAY),
  aiCycleSpentMicros: 0,
  aiTopUpMicros: 0,
  ...over,
});

describe('venue AI credit', () => {
  it('gives a paid venue its plan’s monthly credit, minus what this window used', () => {
    const v = creditView(row({ aiCycleSpentMicros: 1_250_000 }), facts, NOW);
    expect(v).toMatchObject({
      source: 'plan',
      allowanceUsd: 4,
      usedUsd: 1.25,
      balanceUsd: 2.75,
      paused: false,
    });
  });

  it('gives a trial venue the small one-off trial credit, whatever plan it is nominally on', () => {
    const v = creditView(
      row({
        aiTrial: true,
        planKey: 'business',
        aiCycleStartedAt: null,
        aiCycleEndsAt: null,
      }),
      { ...facts, planUsd: 10 },
      NOW,
    );
    expect(v).toMatchObject({
      source: 'trial',
      allowanceUsd: 0.5,
      balanceUsd: 0.5,
    });
  });

  it('shares one trial credit across the same owner’s trial venues', () => {
    const v = creditView(
      row({ aiTrial: true, aiCycleEndsAt: null }),
      { ...facts, otherTrialSpentMicros: 400_000 },
      NOW,
    );
    expect(v.balanceUsd).toBeCloseTo(0.1);
    expect(v.roomMicros).toBe(100_000);
  });

  it('lets the admin override beat the plan and the trial', () => {
    expect(
      creditView(row({ aiCreditOverrideUsd: 12 }), facts, NOW),
    ).toMatchObject({ source: 'override', allowanceUsd: 12, balanceUsd: 12 });
    expect(
      creditView(
        row({ aiTrial: true, aiCreditOverrideUsd: 0 }),
        { ...facts, otherTrialSpentMicros: 1 },
        NOW,
      ),
    ).toMatchObject({ source: 'override', balanceUsd: 0 });
  });

  it('adds unused top-up credit on top of the allowance', () => {
    const v = creditView(
      row({ aiCycleSpentMicros: 4_000_000, aiTopUpMicros: 3_000_000 }),
      facts,
      NOW,
    );
    expect(v).toMatchObject({ usedUsd: 4, topUpUsd: 3, balanceUsd: 3 });
  });

  it('pauses the monthly credit once the plan is past its grace period, but keeps top-ups', () => {
    const overdue = row({
      currentPeriodEnd: new Date(NOW.getTime() - 20 * DAY),
      aiTopUpMicros: 500_000,
    });
    expect(creditView(overdue, facts, NOW)).toMatchObject({
      paused: true,
      allowanceUsd: 4,
      balanceUsd: 0.5,
    });
    const grace = row({ currentPeriodEnd: new Date(NOW.getTime() - 3 * DAY) });
    expect(creditView(grace, facts, NOW)).toMatchObject({
      paused: false,
      balanceUsd: 4,
    });
  });

  it('starts a fresh window when the stored one ran out, in whole 30-day steps', () => {
    const ended = new Date(NOW.getTime() - 45 * DAY);
    const w = dueWindow({ aiTrial: false, aiCycleEndsAt: ended }, NOW)!;
    expect(w.start.getTime()).toBe(ended.getTime() + CREDIT_WINDOW_DAYS * DAY);
    expect(w.end.getTime() - w.start.getTime()).toBe(CREDIT_WINDOW_DAYS * DAY);
    expect(
      creditView(
        row({ aiCycleEndsAt: ended, aiCycleSpentMicros: 4_000_000 }),
        facts,
        NOW,
      ),
    ).toMatchObject({ usedUsd: 0, balanceUsd: 4 });
  });

  it('never renews a trial credit by itself', () => {
    expect(dueWindow({ aiTrial: true, aiCycleEndsAt: null }, NOW)).toBeNull();
    expect(
      dueWindow(
        { aiTrial: false, aiCycleEndsAt: new Date(NOW.getTime() + DAY) },
        NOW,
      ),
    ).toBeNull();
  });

  it('ends the trial and opens a 30-day window when time is added', () => {
    expect(freshAiCycle(NOW)).toEqual({
      aiTrial: false,
      aiCycleStartedAt: NOW,
      aiCycleEndsAt: new Date(NOW.getTime() + 30 * DAY),
      aiCycleSpentMicros: 0,
    });
  });

  it('maps every plan to its own setting and unknown plans to Pro', () => {
    expect(planCreditSetting('starter')).toBe('creditStarterUsd');
    expect(planCreditSetting('gaming-lite')).toBe('creditGamingLiteUsd');
    expect(planCreditSetting('legacy')).toBe('creditProUsd');
  });

  it('shows the owner only what was credited, never what Matchena received', () => {
    const topUp = {
      id: 't1',
      creditedMicros: 2_000_000,
      createdAt: NOW,
      receivedAmount: 15_000,
      receivedCurrency: 'EGP',
      note: 'margin',
    };
    const dto = ownerCreditDto(creditView(row(), facts, NOW), [topUp]);
    expect(dto.topUps).toEqual([{ id: 't1', creditedUsd: 2, createdAt: NOW }]);
    const json = JSON.stringify(dto);
    expect(json).not.toMatch(/received|15000|margin|roomMicros/);
    expect(dto.renewsAt).toEqual(row().aiCycleEndsAt);
  });
});
