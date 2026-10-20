/**
 * Public plan catalog, per venue per month, in piasters. The same numbers are shown on
 * /partners/pricing (web app: PARTNER_PLANS). Change both together.
 *
 * Plans are commercial terms, not feature locks: nothing in the product is switched off
 * when a venue is over its court count or its plan ends.
 */
export const SUBSCRIPTION_PLANS = {
  starter: { listPrice: 100_000, maxUnits: 2, assistantRequests: 200 },
  pro: { listPrice: 200_000, maxUnits: 5, assistantRequests: 1_000 },
  business: { listPrice: 350_000, maxUnits: null, assistantRequests: 3_000 },
  'gaming-lite': { listPrice: 30_000, maxUnits: 10, assistantRequests: 200 },
  'gaming-pro': { listPrice: 60_000, maxUnits: null, assistantRequests: 1_000 },
} as const;

export type PlanKey = keyof typeof SUBSCRIPTION_PLANS;

export const PLAN_KEYS = Object.keys(SUBSCRIPTION_PLANS) as PlanKey[];

/** New venues trial the Pro plan, so the owner sees the full product and its real list price. */
export const DEFAULT_PLAN_KEY: PlanKey = 'pro';

/** Annual billing: pay for this many months, get twelve. */
export const ANNUAL_PAID_MONTHS = 10;

export function isPlanKey(value: unknown): value is PlanKey {
  return typeof value === 'string' && (PLAN_KEYS as string[]).includes(value);
}

export function planListPrice(key: string): number | null {
  return isPlanKey(key) ? SUBSCRIPTION_PLANS[key].listPrice : null;
}
