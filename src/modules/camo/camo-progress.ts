/** Section 16: XP, levels, daily missions and cosmetics as pure rules (the service stores them). */
export interface ProgressSettings {
  xpPerMatch: number;
  xpWinBonus: number;
  xpPerRedCard: number;
  xpPerSurvivedRound: number;
  coinsPerMatch: number;
  coinsWinBonus: number;
  coinsDailyCap: number;
  missionCoins: number;
}

export interface MatchDelta {
  won: boolean;
  /** Rounds played as a hider and not caught. */
  survivedRounds: number;
  redCards: number;
  stampsUsed: number;
  rounds: number;
}

export const xpFor = (d: MatchDelta, s: ProgressSettings): number => s.xpPerMatch + (d.won ? s.xpWinBonus : 0) + d.redCards * s.xpPerRedCard + d.survivedRounds * s.xpPerSurvivedRound;

/** Level n needs 60·(n-1)² total XP: quick early, slower later. */
export const levelOf = (xp: number): number => Math.floor(Math.sqrt(Math.max(0, xp) / 60)) + 1;
export const xpForLevel = (level: number): number => 60 * (level - 1) ** 2;

/** Coins for one match, held back by the daily cap. Guests earn none (they are told to sign up to keep rewards). */
export function coinsFor(d: MatchDelta, s: ProgressSettings, earnedToday: number, guest: boolean): number {
  if (guest) return 0;
  const raw = s.coinsPerMatch + (d.won ? s.coinsWinBonus : 0);
  return Math.max(0, Math.min(raw, s.coinsDailyCap - earnedToday));
}

export interface MissionDef {
  id: 'stay_twice' | 'three_reds' | 'stamp_paint';
  metric: 'survivedRounds' | 'redCards' | 'stampsUsed';
  target: number;
}

export const MISSIONS: readonly MissionDef[] = [
  { id: 'stay_twice', metric: 'survivedRounds', target: 2 },
  { id: 'three_reds', metric: 'redCards', target: 3 },
  { id: 'stamp_paint', metric: 'stampsUsed', target: 1 },
];

export interface MissionState {
  day: string;
  progress: Record<string, number>;
  done: string[];
}

/** Adds a match to the day's missions (a new day starts clean) and says which ones just completed. */
export function applyMissions(state: MissionState | null | undefined, delta: MatchDelta, day: string): { state: MissionState; completed: MissionDef[] } {
  const cur: MissionState = state && state.day === day ? { day, progress: { ...state.progress }, done: [...state.done] } : { day, progress: {}, done: [] };
  const completed: MissionDef[] = [];
  for (const m of MISSIONS) {
    if (cur.done.includes(m.id)) continue;
    cur.progress[m.id] = Math.min(m.target, (cur.progress[m.id] ?? 0) + delta[m.metric]);
    if (cur.progress[m.id] >= m.target) {
      cur.done.push(m.id);
      completed.push(m);
    }
  }
  return { state: cur, completed };
}

export type CosmeticKind = 'red_card_anim' | 'var_frame' | 'name_style' | 'win_dance' | 'taunt_sound';

export interface Cosmetic {
  id: string;
  kind: CosmeticKind;
  /** Coins; 0 = unlocked by level. */
  cost: number;
  minLevel: number;
}

/** Cosmetics only: nothing here changes how the game is played, and every tool, pose and room is free. */
export const COSMETICS: readonly Cosmetic[] = [
  { id: 'redcard_confetti', kind: 'red_card_anim', cost: 60, minLevel: 2 },
  { id: 'redcard_flame', kind: 'red_card_anim', cost: 120, minLevel: 5 },
  { id: 'varframe_gold', kind: 'var_frame', cost: 80, minLevel: 3 },
  { id: 'varframe_neon', kind: 'var_frame', cost: 100, minLevel: 4 },
  { id: 'name_lime', kind: 'name_style', cost: 40, minLevel: 2 },
  { id: 'name_gold', kind: 'name_style', cost: 90, minLevel: 4 },
  { id: 'dance_shimmy', kind: 'win_dance', cost: 70, minLevel: 3 },
  { id: 'dance_sprint', kind: 'win_dance', cost: 110, minLevel: 6 },
  { id: 'taunt_horn', kind: 'taunt_sound', cost: 50, minLevel: 2 },
  { id: 'taunt_whistle', kind: 'taunt_sound', cost: 50, minLevel: 3 },
];

export interface CosmeticState {
  owned: string[];
  equipped: Partial<Record<CosmeticKind, string>>;
}

export type BuyResult = { ok: true; cost: number } | { ok: false; reason: 'unknown' | 'owned' | 'level' | 'coins' | 'guest' };

export function canBuy(id: string, level: number, coins: number, state: CosmeticState, guest: boolean): BuyResult {
  const c = COSMETICS.find((x) => x.id === id);
  if (!c) return { ok: false, reason: 'unknown' };
  if (guest) return { ok: false, reason: 'guest' };
  if (state.owned.includes(id)) return { ok: false, reason: 'owned' };
  if (level < c.minLevel) return { ok: false, reason: 'level' };
  if (coins < c.cost) return { ok: false, reason: 'coins' };
  return { ok: true, cost: c.cost };
}

export function equip(id: string | null, kind: CosmeticKind, state: CosmeticState): CosmeticState | null {
  if (id === null) {
    const next = { owned: state.owned, equipped: { ...state.equipped } };
    delete next.equipped[kind];
    return next;
  }
  const c = COSMETICS.find((x) => x.id === id);
  if (!c || c.kind !== kind || !state.owned.includes(id)) return null;
  return { owned: state.owned, equipped: { ...state.equipped, [kind]: id } };
}
