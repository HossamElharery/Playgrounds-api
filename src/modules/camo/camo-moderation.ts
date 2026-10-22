import type { CamoMatch, CamoPlayer } from './camo-rules';

/** Section 17a: room votes (mute / kick), pure so the quorum rules are testable without a socket. */
export interface VoteSettings {
  muteVoteSeconds: number;
  muteVoteMinYes: number;
  kickVotePct: number;
  kickVoteMinYes: number;
  voteCooldownSeconds: number;
  noVoteLastSeconds: number;
}

export type VoteKind = 'mute' | 'kick';

export interface RoomVote {
  id: string;
  kind: VoteKind;
  targetUserId: string;
  targetEid: string;
  startedBy: string;
  startedAt: number;
  endsAt: number;
  /** Vote groups: a party counts once, everyone else counts as themselves. */
  yes: Set<string>;
  no: Set<string>;
  resolved: boolean;
  outcome: 'passed' | 'failed' | null;
}

export interface ModerationState {
  votes: Map<string, RoomVote>;
  starterCooldown: Map<string, number>;
  /** After a failed vote the same person is protected for a while. */
  targetCooldown: Map<string, number>;
  muted: Set<string>;
  /** Kicks that passed too close to the end of a round: applied when the round is over. */
  deferred: Array<{ userId: string; voters: string[] }>;
  /** The last minutes of what happened in the room (cards, catches, votes): the context a report carries. Never audio. */
  log: Array<{ t: number; k: string; d?: unknown }>;
  seq: number;
}

export const newModeration = (): ModerationState => ({
  votes: new Map(),
  starterCooldown: new Map(),
  targetCooldown: new Map(),
  muted: new Set(),
  deferred: [],
  log: [],
  seq: 1,
});

const groupOf = (p: CamoPlayer): string => (p.partyId ? `party:${p.partyId}` : `user:${p.userId}`);

/** The real people who may vote on `targetUserId` (no bots, no covered seats, not the target). */
export function electorate(m: CamoMatch, targetUserId: string): CamoPlayer[] {
  return m.players.filter((p) => !p.isBot && !p.botCover && p.connected && p.userId && p.userId !== targetUserId);
}

export type StartDenied = 'private' | 'self' | 'unknown' | 'bot' | 'cooldown' | 'protected' | 'active' | 'late' | 'few' | 'not_in_room';

/** Whether a vote may start right now: not in the last seconds of a round, not in the VAR or the results. */
export function votingOpen(m: CamoMatch, cfg: VoteSettings, now: number): boolean {
  if (m.phase === 'var' || m.phase === 'results' || m.phase === 'ended') return false;
  if (m.phase === 'hunt' && m.phaseEndsAt - now < cfg.noVoteLastSeconds * 1000) return false;
  return true;
}

export function startVote(
  m: CamoMatch,
  by: string,
  targetEid: string,
  kind: VoteKind,
  cfg: VoteSettings,
  now: number,
): { ok: true; vote: RoomVote } | { ok: false; reason: StartDenied } {
  if (m.isPrivate) return { ok: false, reason: 'private' };
  const starter = m.players.find((p) => p.userId === by);
  if (!starter) return { ok: false, reason: 'not_in_room' };
  const target = m.players.find((p) => p.eid === targetEid);
  if (!target) return { ok: false, reason: 'unknown' };
  if (target.isBot || !target.userId) return { ok: false, reason: 'bot' };
  if (target.userId === by) return { ok: false, reason: 'self' };
  const mod = m.mod;
  if (!votingOpen(m, cfg, now)) return { ok: false, reason: 'late' };
  if ((mod.starterCooldown.get(by) ?? 0) > now) return { ok: false, reason: 'cooldown' };
  if ((mod.targetCooldown.get(target.userId) ?? 0) > now) return { ok: false, reason: 'protected' };
  for (const v of mod.votes.values()) if (!v.resolved && v.targetUserId === target.userId) return { ok: false, reason: 'active' };
  const need = kind === 'mute' ? cfg.muteVoteMinYes : cfg.kickVoteMinYes;
  const groups = new Set(electorate(m, target.userId).map(groupOf));
  if (groups.size < need) return { ok: false, reason: 'few' };
  const vote: RoomVote = {
    id: `v${mod.seq++}`,
    kind,
    targetUserId: target.userId,
    targetEid,
    startedBy: by,
    startedAt: now,
    endsAt: now + cfg.muteVoteSeconds * 1000,
    yes: new Set([groupOf(starter)]),
    no: new Set(),
    resolved: false,
    outcome: null,
  };
  mod.votes.set(vote.id, vote);
  mod.starterCooldown.set(by, now + cfg.voteCooldownSeconds * 1000);
  return { ok: true, vote };
}

export function castVote(m: CamoMatch, userId: string, voteId: string, yes: boolean): boolean {
  const vote = m.mod.votes.get(voteId);
  const p = m.players.find((x) => x.userId === userId);
  if (!vote || vote.resolved || !p || p.userId === vote.targetUserId || p.isBot) return false;
  const g = groupOf(p);
  vote.yes.delete(g);
  vote.no.delete(g);
  (yes ? vote.yes : vote.no).add(g);
  return true;
}

export interface Tally {
  yes: number;
  no: number;
  groups: number;
  needed: number;
  passed: boolean;
  /** Nobody left to ask, or the result can no longer change. */
  decided: boolean;
}

export function tally(m: CamoMatch, vote: RoomVote, cfg: VoteSettings): Tally {
  const groups = new Set(electorate(m, vote.targetUserId).map(groupOf));
  // a voter who left no longer counts, and the starter's own party counts as their one yes
  const yes = [...vote.yes].filter((g) => groups.has(g)).length;
  const no = [...vote.no].filter((g) => groups.has(g)).length;
  const n = groups.size;
  const needed = vote.kind === 'mute' ? Math.max(cfg.muteVoteMinYes, Math.floor(n / 2) + 1) : Math.max(cfg.kickVoteMinYes, Math.ceil(n * cfg.kickVotePct));
  const passed = yes >= needed;
  const decided = passed || yes + (n - yes - no) < needed || yes + no >= n;
  return { yes, no, groups: n, needed, passed, decided };
}

export interface VoteResult {
  vote: RoomVote;
  passed: boolean;
  /** Who voted yes (a failed or kicked-out target is later avoided by them for 24 h). */
  voters: string[];
}

/** Resolves every vote that is decided or out of time; returns what happened so the host can apply it. */
export function stepVotes(m: CamoMatch, cfg: VoteSettings, now: number): VoteResult[] {
  const out: VoteResult[] = [];
  for (const vote of m.mod.votes.values()) {
    if (vote.resolved) continue;
    const t = tally(m, vote, cfg);
    const targetGone = !m.players.some((p) => p.userId === vote.targetUserId && p.connected);
    if (!t.decided && now < vote.endsAt && !targetGone) continue;
    vote.resolved = true;
    vote.outcome = t.passed && !targetGone ? 'passed' : 'failed';
    if (vote.outcome === 'failed') m.mod.targetCooldown.set(vote.targetUserId, now + cfg.voteCooldownSeconds * 1000);
    const voters = m.players.filter((p) => p.userId && vote.yes.has(groupOf(p)) && p.userId !== vote.targetUserId).map((p) => p.userId as string);
    out.push({ vote, passed: vote.outcome === 'passed', voters });
  }
  return out;
}

export function logEvent(m: CamoMatch, k: string, d: unknown, now: number): void {
  m.mod.log.push({ t: now, k, d });
  if (m.mod.log.length > 300) m.mod.log.splice(0, m.mod.log.length - 300);
}

/** The last `ms` of the room's event log, with times relative to `now` (what a moderator reads). */
export function recentLog(m: CamoMatch, now: number, ms = 60_000): Array<{ agoMs: number; k: string; d?: unknown }> {
  return m.mod.log.filter((e) => now - e.t <= ms).map((e) => ({ agoMs: now - e.t, k: e.k, d: e.d }));
}
