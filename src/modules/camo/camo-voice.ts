import type { CamoMatch, CamoPlayer } from './camo-rules';

/** Proximity voice (section 10): the SERVER decides who hears whom, so a modified client gains nothing. */
export const VOICE_RANGE_M = 15;
export const VOICE_MAX_LINKS = 5;
/** A "talking" flag lives this long without a refresh. */
export const SPEAKING_HOLD_MS = 900;

export interface VoiceEntry {
  userId: string;
  /** 0..1, channel rules and distance already applied. */
  gain: number;
  /** Where the sound comes from; absent when the room is one open channel (waiting, VAR, results). */
  x?: number;
  z?: number;
}

export interface VoiceMap {
  /** Only people who are talking right now and are audible (a silent hider is never listed: no position leak). */
  peers: VoiceEntry[];
  /** The up-to-5 nearest people this listener should keep a connection with (squad mates stay connected regardless). */
  connect: string[];
}

const OPEN_PHASES = new Set(['waiting', 'reveal', 'var', 'results', 'ended']);

const isSpectator = (p: CamoPlayer): boolean => p.role === 'spectator' || (p.role === 'hider' && !p.alive);

/** Whether `speaker` may be heard by `listener` in this phase, before distance (the channel table of section 10). */
export function channelOpen(phase: string, listener: CamoPlayer, speaker: CamoPlayer): boolean {
  if (OPEN_PHASES.has(phase)) return true;
  const ls = isSpectator(listener);
  const ss = isSpectator(speaker);
  if (phase === 'prep') {
    // seekers wait in the referee room and hear only each other; hiders hear hiders and never a seeker's room talk
    if (listener.role === 'seeker') return speaker.role === 'seeker';
    return !ss && speaker.role === 'hider';
  }
  // whistle and hunt
  if (ss) return ls; // the stands talk to the stands only
  return true; // living players by proximity, the stands hear everyone
}

export function voiceMapFor(m: CamoMatch, listener: CamoPlayer, now: number): VoiceMap {
  const open = OPEN_PHASES.has(m.phase);
  const near: Array<{ p: CamoPlayer; d: number }> = [];
  const peers: VoiceEntry[] = [];
  for (const sp of m.players) {
    if (sp === listener || sp.isBot || !sp.userId || !sp.connected) continue;
    if (m.mod.muted.has(sp.userId) || listener.localMuted.has(sp.eid)) continue;
    if (!channelOpen(m.phase, listener, sp)) continue;
    const d = Math.hypot(sp.x - listener.x, sp.z - listener.z);
    if (!open && !isSpectator(listener) && d > VOICE_RANGE_M) continue;
    near.push({ p: sp, d });
    // an open channel has no positions, so listing a quiet person leaks nothing: they simply are audible
    if (open) {
      peers.push({ userId: sp.userId, gain: 1 });
      continue;
    }
    if (sp.speakingUntil <= now) continue;
    if (isSpectator(listener) || isSpectator(sp)) peers.push({ userId: sp.userId, gain: 1, x: sp.x, z: sp.z });
    else peers.push({ userId: sp.userId, gain: Math.max(0, 1 - d / VOICE_RANGE_M), x: sp.x, z: sp.z });
  }
  near.sort((a, b) => a.d - b.d);
  return { peers, connect: near.slice(0, VOICE_MAX_LINKS).map((n) => n.p.userId as string) };
}
