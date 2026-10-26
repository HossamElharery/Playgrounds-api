import type { VenueSubscription } from '@prisma/client';
import type { AiSettingKey } from '../ai-settings.service';
import { fromMicros, toMicros } from '../ai-day';
import { DAY_MS, subscriptionStanding } from '../../subscriptions/subscription-state.util';
import { DEFAULT_PLAN_KEY, isPlanKey, type PlanKey } from '../../subscriptions/subscription-plans';

/**
 * The owner assistant's monthly credit, per venue, in USD of real provider cost.
 *
 * One balance per venue, shared by the owner and every staff login. A window lasts 30 days and
 * a new one starts whenever an admin adds time to the subscription. Spending goes against the
 * window's allowance first, then against top-up credit, which carries over between windows.
 * A trial gets one small one-off credit instead of the plan's monthly one.
 */
export const CREDIT_WINDOW_DAYS = 30;
const WINDOW_MS = CREDIT_WINDOW_DAYS * DAY_MS;

export const PLAN_CREDIT_SETTING: Record<PlanKey, AiSettingKey> = {
  starter: 'creditStarterUsd',
  pro: 'creditProUsd',
  business: 'creditBusinessUsd',
  'gaming-lite': 'creditGamingLiteUsd',
  'gaming-pro': 'creditGamingProUsd',
};

export function planCreditSetting(planKey: string): AiSettingKey {
  return PLAN_CREDIT_SETTING[isPlanKey(planKey) ? planKey : DEFAULT_PLAN_KEY];
}

export type CreditRow = Pick<
  VenueSubscription,
  | 'venueId'
  | 'planKey'
  | 'currentPeriodEnd'
  | 'graceDays'
  | 'aiAssistantEnabled'
  | 'aiCreditOverrideUsd'
  | 'aiTrial'
  | 'aiCycleStartedAt'
  | 'aiCycleEndsAt'
  | 'aiCycleSpentMicros'
  | 'aiTopUpMicros'
>;

export const CREDIT_ROW_SELECT = {
  venueId: true,
  planKey: true,
  currentPeriodEnd: true,
  graceDays: true,
  aiAssistantEnabled: true,
  aiCreditOverrideUsd: true,
  aiTrial: true,
  aiCycleStartedAt: true,
  aiCycleEndsAt: true,
  aiCycleSpentMicros: true,
  aiTopUpMicros: true,
} as const;

/** What adding time to a subscription does to its AI credit: the trial ends and a fresh window opens. */
export function freshAiCycle(now: Date = new Date()) {
  return {
    aiTrial: false,
    aiCycleStartedAt: now,
    aiCycleEndsAt: new Date(now.getTime() + WINDOW_MS),
    aiCycleSpentMicros: 0,
  };
}

/** The window `now` falls in when the stored one has run out (whole 30-day steps), else null. */
export function dueWindow(
  row: Pick<CreditRow, 'aiTrial' | 'aiCycleEndsAt'>,
  now: Date,
): { start: Date; end: Date } | null {
  if (row.aiTrial) return null;
  const end = row.aiCycleEndsAt?.getTime();
  if (end !== undefined && now.getTime() < end) return null;
  const start = end === undefined ? now.getTime() : end + Math.floor((now.getTime() - end) / WINDOW_MS) * WINDOW_MS;
  return { start: new Date(start), end: new Date(start + WINDOW_MS) };
}

export interface CreditFacts {
  /** The plan's monthly credit from the AI settings. */
  planUsd: number;
  /** The one-off trial credit from the AI settings. */
  trialUsd: number;
  /** What the same owner's other trial venues already used: one trial credit per owner. */
  otherTrialSpentMicros?: number;
}

export interface VenueAiCreditView {
  venueId: string;
  enabled: boolean;
  trial: boolean;
  source: 'override' | 'plan' | 'trial';
  /** The monthly allowance (or the trial's one-off credit) before anything is used. */
  allowanceUsd: number;
  /** The subscription is past its grace period, so the allowance is not available until renewal. */
  paused: boolean;
  /** Charged against the allowance in this window. */
  usedUsd: number;
  /** Top-up credit still unused. */
  topUpUsd: number;
  /** What can still be spent right now. */
  balanceUsd: number;
  cycleStartedAt: Date | null;
  cycleEndsAt: Date | null;
  /** How much of the allowance this venue may charge, in micro-USD (internal, for `charge`). */
  roomMicros: number;
}

/** The credit as it stands at `now`, as if a window that ran out had already been rolled over. */
export function creditView(row: CreditRow, facts: CreditFacts, now: Date = new Date()): VenueAiCreditView {
  const due = dueWindow(row, now);
  const spent = due ? 0 : Math.max(0, row.aiCycleSpentMicros);
  const source = row.aiCreditOverrideUsd != null ? 'override' : row.aiTrial ? 'trial' : 'plan';
  const baseUsd =
    source === 'override' ? (row.aiCreditOverrideUsd ?? 0) : source === 'trial' ? facts.trialUsd : facts.planUsd;
  const paused = subscriptionStanding(row, now).state === 'overdue';
  const allowance = paused ? 0 : toMicros(baseUsd);
  const room = Math.max(0, allowance - (source === 'trial' ? (facts.otherTrialSpentMicros ?? 0) : 0));
  const topUp = Math.max(0, row.aiTopUpMicros);
  return {
    venueId: row.venueId,
    enabled: row.aiAssistantEnabled,
    trial: row.aiTrial,
    source,
    allowanceUsd: fromMicros(toMicros(baseUsd)),
    paused,
    usedUsd: fromMicros(spent),
    topUpUsd: fromMicros(topUp),
    balanceUsd: fromMicros(Math.max(0, room - spent) + topUp),
    cycleStartedAt: due ? due.start : row.aiCycleStartedAt,
    cycleEndsAt: due ? due.end : row.aiCycleEndsAt,
    roomMicros: room,
  };
}

/**
 * What the owner (or a staff login) sees. Built field by field on purpose: what Matchena was
 * paid for a top-up never leaves the admin side. Staff see the balance only, not the history.
 */
export function ownerCreditDto(
  view: VenueAiCreditView,
  topUps: { id: string; creditedMicros: number; createdAt: Date }[] | null,
) {
  return {
    enabled: view.enabled,
    trial: view.trial,
    paused: view.paused,
    allowanceUsd: view.allowanceUsd,
    usedUsd: view.usedUsd,
    topUpUsd: view.topUpUsd,
    balanceUsd: view.balanceUsd,
    renewsAt: view.trial || view.paused ? null : view.cycleEndsAt,
    topUps: topUps?.map((t) => ({ id: t.id, creditedUsd: fromMicros(t.creditedMicros), createdAt: t.createdAt })) ?? null,
  };
}
