/**
 * One place for every number that decides how hard it is to earn coins.
 * Coins are money (20 coins = 1 EGP, paid out of Matchena's commission when a
 * player spends them), so engagement coins are paid only to real players:
 * someone who has had a paid booking checked in at a venue (`User.trustedAt`).
 */

/** A booking at or above this total (minor units) makes a player "trusted". */
export const TRUST_MIN_BOOKING_TOTAL = 5000;

/** Engagement coins (check-in, games, match rewards) one player can be paid per rolling 24 hours. */
export const ENGAGEMENT_DAILY_CAP_COINS = 60;

/** Pending rewards nobody claimed after this long are voided. */
export const PENDING_GRANT_TTL_MS = 180 * 86_400_000;

/** Referral coins are held this long so a refunded / fake first booking can be caught. */
export const REFERRAL_HOLD_MS = 7 * 86_400_000;
export const REFERRAL_BONUS_COINS = 300;
/** One person can be paid for at most this many referrals per 30 days. */
export const REFERRAL_MONTHLY_CAP = 10;

export const DAILY_CHECKIN_COINS = 5;
export const MATCH_PLAYED_COINS = 30;
export const PLAYER_RATING_COINS = 10;
export const REVIEW_PHOTO_BONUS_COINS = 50;

/** Largest share of a booking a player can pay with coins. */
export const MAX_COIN_DISCOUNT_PCT = 20;

/** A posted match counts as played only with this many other approved players. */
export const MATCH_MIN_OTHER_PLAYERS = 1;

/**
 * Most a single player can add to one metric per Cairo day. A metric not
 * listed here is uncapped (bookings and reviews are already limited by real money).
 */
export function metricDailyMax(metric: string): number | null {
  if (metric === 'game.win') return 8;
  if (metric.startsWith('game.win.')) return 5;
  if (metric === 'game.played') return 10;
  if (metric === 'match.hosted') return 2;
  if (metric === 'match.played') return 2;
  if (metric === 'mvp.awarded') return 3;
  return null;
}

/** Cairo calendar day, yyyy-mm-dd. */
export function cairoDayKey(at = Date.now()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(at));
}
