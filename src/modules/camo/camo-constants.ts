/**
 * Shared constants of «استغماية». Everything here is data: the pure rule modules, the host and the tests read it,
 * and the client keeps a mirror (checked by the protocol handshake and the shared fixtures).
 */

/** Bump when an event payload or a rule changes in a way an old client cannot follow (`camo.hello`). */
export const CAMO_PROTOCOL_VERSION = 1;

export type CamoPhase =
  | 'waiting'
  | 'reveal'
  | 'prep'
  | 'whistle'
  | 'hunt'
  | 'var'
  | 'results'
  | 'ended';
export type CamoRole = 'hider' | 'seeker' | 'spectator';
export type CamoMode = 'classic' | 'contagion';

/** Default timers (ms); a private room's host may tune the ones marked (prep 45-90 s, hunt 120-300 s). */
export const TIMERS = Object.freeze({
  waitingMaxMs: 12_000,
  revealMs: 4_000,
  prepMs: 60_000,
  prepMinMs: 45_000,
  prepMaxMs: 90_000,
  whistleMs: 2_000,
  huntMs: 180_000,
  huntMinMs: 120_000,
  huntMaxMs: 300_000,
  stoppageMs: 30_000,
  varMs: 30_000,
  resultsMs: 15_000,
  /** Seat kept for a dropped player, then a bot takes over. */
  reconnectHoldMs: 20_000,
});

export const ROUNDS_PER_MATCH = 3;
export const MIN_PLAYERS = 4;
export const MAX_PLAYERS = 10;
export const DEFAULT_PLAYERS = 8;

/** Seekers per room size (section 4.3): 4-5 -> 1, 6-9 -> 2, 10 -> 3. */
export function seekerCount(players: number): number {
  if (players >= 10) return 3;
  if (players >= 6) return 2;
  return 1;
}

/** Everybody hides in the same box: the owner's «no morph has an advantage» rule. Poses never change it. */
export const HIT_VOLUME = Object.freeze({ radius: 0.3, height: 1.6 });

export const MOVE = Object.freeze({
  walk: 3.0,
  seekerRun: 4.8,
  /** Seconds of running, then recovery (section 5.2). */
  runSeconds: 4,
  recoverSeconds: 3,
  /** Slack on top of the speed limit, like `lobby-move.util`. */
  slack: 1.5,
  maxCreditS: 1,
  teleportSlack: 0.5,
});

export const TICK_HZ = 10;
export const TICK_MS = 1000 / TICK_HZ;

export const CARD = Object.freeze({
  /** Yellow cards that trigger a suspension. */
  yellowsForSuspension: 3,
  suspensionMs: 4_000,
  tagRange: 1.6,
  tagConeDeg: 60,
  tagLungeMs: 400,
  tagCooldownMs: 1_000,
  /** A seeker's ball is back this long after it stops or first hits something. */
  ballReturnMs: 1_500,
  ballMaxFlightMs: 4_000,
  /** The origin a kick claims must be this close to where the seeker really is. */
  kickOriginSlack: 0.5,
  shotSpeed: 22,
  lobMaxSpeed: 14,
  effectiveRange: 14,
});

export const WHISTLE = Object.freeze({ everyMs: 45_000, range: 20 });
export const SCAN = Object.freeze({ everyMs: 60_000, range: 10 });
export const TAUNT = Object.freeze({ cooldownMs: 20_000, range: 18 });
export const TOUCH_UP_MS = 5_000;

export const POINTS = Object.freeze({
  hiderSecond: 1,
  dangerMultiplier: 3,
  dangerRange: 3,
  lastHider: 50,
  tauntBonus: 15,
  redCard: 40,
  redCardSpeedPer3s: 1,
  yellowCard: -10,
});

/** Section 5.4 awards: stable ids, the client owns the Egyptian wording through i18n. */
export const AWARDS = [
  'golden_chameleon',
  'passed_by_five_times',
  'caught_before_hiding',
  'unfair_referee',
  'eagle_eye',
  'overconfident',
  'caught_by_mistake',
  'sniper',
] as const;
export type CamoAward = (typeof AWARDS)[number];

/** The 11 shared poses; the signature pose of a morph rides as `signature`. */
export const POSE_IDS = [
  'stand', 'crouch', 'bend', 'lean_l', 'lean_r', 'ball', 'flat', 'side', 'wall', 'upside', 'sit', 'signature',
] as const;
export type CamoPoseId = (typeof POSE_IDS)[number];

/** Event rate limits (per user, events per second), section 17. */
export const RATE = Object.freeze({ move: 20, paint: 6, pose: 4, kick: 3, tag: 3, whistle: 1, emoji: 0.5 });
