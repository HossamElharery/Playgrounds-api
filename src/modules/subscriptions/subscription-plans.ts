/**
 * Venue plans. What a plan covers is the same everywhere; its price depends on the venue's
 * currency (from its country), never on where the visitor browsing the website is.
 * The web /partners/pricing page shows the same numbers (src/app/core/config/venue-plans.ts).
 *
 * Plans are commercial terms, not feature locks: nothing in the product is switched off
 * when a venue is over its court count or its plan ends.
 */
export const SUBSCRIPTION_PLANS = {
  starter: { maxUnits: 2, assistantRequests: 200 },
  pro: { maxUnits: 5, assistantRequests: 1_000 },
  business: { maxUnits: null, assistantRequests: 3_000 },
  'gaming-lite': { maxUnits: 10, assistantRequests: 200 },
  'gaming-pro': { maxUnits: null, assistantRequests: 1_000 },
} as const;

export type PlanKey = keyof typeof SUBSCRIPTION_PLANS;

export const PLAN_KEYS = Object.keys(SUBSCRIPTION_PLANS) as PlanKey[];

/**
 * Public list prices per month, in minor units, by currency. A currency that is not listed
 * has no public price yet: its venues get a list price of 0 and the admin agrees the price.
 */
export const PLAN_PRICES: Partial<Record<string, Record<PlanKey, number>>> = {
  EGP: {
    starter: 100_000,
    pro: 200_000,
    business: 350_000,
    'gaming-lite': 30_000,
    'gaming-pro': 60_000,
  },
  SAR: { starter: 7_900, pro: 19_900, business: 39_900, 'gaming-lite': 3_900, 'gaming-pro': 7_900 },
  AED: { starter: 14_900, pro: 29_900, business: 59_900, 'gaming-lite': 5_900, 'gaming-pro': 11_900 },
};

/** New venues trial the Pro plan, so the owner sees the full product and its real list price. */
export const DEFAULT_PLAN_KEY: PlanKey = 'pro';

/** Annual billing: pay for this many months, get twelve. */
export const ANNUAL_PAID_MONTHS = 10;

export function isPlanKey(value: unknown): value is PlanKey {
  return typeof value === 'string' && (PLAN_KEYS as string[]).includes(value);
}

/** The plan's public monthly price in this currency, or null when that currency has none. */
export function planListPrice(key: string, currency = 'EGP'): number | null {
  if (!isPlanKey(key)) return null;
  return PLAN_PRICES[currency.toUpperCase()]?.[key] ?? null;
}
