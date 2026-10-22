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

/** What a listener is told about the voice map: nobody is named by a user id, only by the per-match `vid`. */
export interface OpaqueVoice {
  /** The listener's own vid, so both ends of a link agree on who offers (the polite side). */
  me: string;
  peers: Array<[string, number, number | null, number | null]>;
  connect: string[];
  /** vid → real user id, ONLY for party mates (they already know each other and share a call); strangers never appear. */
  alias: Record<string, string>;
}

const r1 = (n: number): number => Math.round(n * 10) / 10;

export function opaqueVoice(m: CamoMatch, listener: CamoPlayer, map: VoiceMap): OpaqueVoice {
  const byUser = new Map<string, CamoPlayer>();
  for (const p of m.players) if (p.userId) byUser.set(p.userId, p);
  const vidOf = (userId: string): string => (byUser.get(userId) as CamoPlayer).vid;
  const alias: Record<string, string> = {};
  if (listener.partyId) {
    for (const p of m.players) if (p !== listener && p.userId && p.partyId === listener.partyId) alias[p.vid] = p.userId;
  }
  return {
    me: listener.vid,
    peers: map.peers.map((e) => [vidOf(e.userId), Math.round(e.gain * 100) / 100, e.x === undefined ? null : r1(e.x), e.z === undefined ? null : r1(e.z as number)]),
    connect: map.connect.map(vidOf),
    alias,
  };
}

/** The user behind a vid in this match, or null (unknown vid, a bot, someone who left). Used only by signalling relays. */
export function userOfVid(m: CamoMatch, vid: string): string | null {
  const p = m.players.find((x) => x.vid === vid);
  return p?.userId && !p.isBot ? p.userId : null;
}
