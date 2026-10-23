/** Headless match driver: used by the simulation spec and the load script. No sockets, a fake clock. */
import { BotBrain, BOT_NAMES_AR } from './camo-bots';
import { buildWalkGrid, generateLockerRoom, type CamoRoomData, type WalkGrid } from './camo-room';
import { createMatch, fillWithBots, step, type CamoMatch, type CamoEvent } from './camo-rules';

let roomCache: { room: CamoRoomData; grid: WalkGrid } | null = null;
export function sharedRoom(): { room: CamoRoomData; grid: WalkGrid } {
  if (!roomCache) {
    const room = generateLockerRoom();
    roomCache = { room, grid: buildWalkGrid(room) };
  }
  return roomCache;
}

export const MORPHS = ['potato', 'banana', 'penguin', 'camel', 'keeper', 'referee', 'dino', 'robot', 'classic', 'guest'];

export interface SimResult {
  match: CamoMatch;
  ticks: number;
  events: CamoEvent[];
  violations: string[];
}

/** Plays a full all-bot match; returns what happened and any invariant that broke on the way. */
export function playBotMatch(seed: number, opts: { players?: number; mode?: 'classic' | 'contagion'; prepMs?: number; huntMs?: number; maxTicks?: number } = {}): SimResult {
  const { room, grid } = sharedRoom();
  const brain = new BotBrain(room, grid);
  let now = 1_000_000;
  const m = createMatch({ id: `sim${seed}`, room, mode: opts.mode ?? 'classic', timers: { prepMs: opts.prepMs ?? 45_000, huntMs: opts.huntMs ?? 120_000 }, botTarget: opts.players ?? 8, seed, now });
  fillWithBots(m, now, (i) => BOT_NAMES_AR[i % BOT_NAMES_AR.length], MORPHS);
  const events: CamoEvent[] = [];
  const violations: string[] = [];
  const { startRound } = require('./camo-rules') as typeof import('./camo-rules');
  startRound(m, room, now);
  const redSeen = new Set<string>();
  let ticks = 0;
  const maxTicks = opts.maxTicks ?? 40_000;
  let lastRound = m.round;
  while (m.phase !== 'ended' && ticks < maxTicks) {
    now += 100;
    ticks++;
    if (m.round !== lastRound) {
      brain.reset();
      redSeen.clear();
      lastRound = m.round;
    }
    brain.tick(m, now);
    step(m, room, now);
    for (const e of m.outbox.splice(0)) {
      events.push(e);
      if (e.t === 'card' && e.kind === 'red' && e.target) {
        const key = `${m.round}:${e.target}`;
        if (redSeen.has(key) && m.mode === 'classic') violations.push(`double red ${key}`);
        redSeen.add(key);
      }
    }
    for (const p of m.players) {
      if (p.suspendedUntil > now) violations.push('a player was suspended');
      if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) violations.push('NaN position');
    }
  }
  if (m.phase !== 'ended') violations.push(`match did not finish in ${maxTicks} ticks (phase ${m.phase})`);
  return { match: m, ticks, events, violations };
}
