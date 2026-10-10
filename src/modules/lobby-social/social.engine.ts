import { randomInt, randomUUID } from 'node:crypto';
import { Exposure, SocialCommand, SocialMember, SocialQuestion, SocialSnapshot, SocialState } from './social.types';

export const SOCIAL_RECONNECT_MS = 30_000;
export const SOCIAL_PULSE_MS = 15_000;
export const socialConnected = (m: SocialMember, now: number) => m.disconnectedAt == null && now - m.lastSeen <= SOCIAL_PULSE_MS;
const connected = socialConnected;
const expired = (m: SocialMember, now: number) => now - (m.disconnectedAt ?? m.lastSeen + SOCIAL_PULSE_MS) > SOCIAL_RECONNECT_MS;
export class SocialRuleError extends Error {
  constructor(readonly code: string) { super(code); }
}
const requireRule = (condition: unknown, code = 'not_allowed'): void => {
  if (!condition) throw new SocialRuleError(code);
};

export function createSocialState(squadId: string, userId: string, cmd: SocialCommand, now: number): SocialState {
  requireRule(cmd.game === 'cards' || cmd.game === 'truth', 'invalid_game');
  const mode = cmd.mode ?? 'light';
  requireRule(['light', 'stories', 'closer'].includes(mode), 'invalid_mode');
  requireRule(mode !== 'closer' || cmd.consent === true, 'consent_required');
  return {
    id: randomUUID(), squadId, game: cmd.game!, cardRound: cmd.game === 'cards' ? { order: [], responses: {} } : undefined, mode, phase: 'preparing', revision: 1,
    hostId: userId, members: [member(userId, 'player', 0, cmd.consent === true, now)],
    roundId: null, roundIndex: 0, actorId: null, targetId: null, lastTargetId: null,
    pairs: {}, usedFamilies: [], question: null, revealAt: null, startedAt: now, phaseAt: now,
    voteDeadline: null, originalVoteDeadline: null, voterIds: [], storyPlayerIds: [], secret: null,
    votes: {}, outcome: null, replayAllowed: cmd.replayAllowed === true, completed: 0,
    message: null, proposedGame: null, confirmedIds: [], receipts: [], cooldowns: {}, lastTags: [],
    reaction: null, nudgeAt: null,
  };
}
function member(userId: string, role: SocialMember['role'], round: number, consent: boolean, now: number): SocialMember {
  return { userId, role, joinedAt: now, eligibleFromRound: round, lastSeen: now,
    viewing: true, disconnectedAt: null, turns: 0, cycleTurns: 0, targets: 0, closerConsent: consent };
}
function players(s: SocialState, now: number, round = s.roundIndex): SocialMember[] {
  return s.members.filter(m => m.role === 'player' && m.eligibleFromRound <= round && connected(m, now) &&
    (s.game !== 'cards' || s.mode !== 'closer' || m.closerConsent));
}
function phase(s: SocialState, next: SocialState['phase'], now: number): void {
  s.phase = next;
  s.phaseAt = now;
}
function nextRound(s: SocialState, now: number): void {
  const eligible = players(s, now, s.roundIndex + 1);
  if (eligible.length < 2) { phase(s, 'paused_insufficient_players', now); return; }
  eligible.sort((a, b) => a.turns - b.turns || a.joinedAt - b.joinedAt || a.userId.localeCompare(b.userId));
  if (eligible.every(m => (m.cycleTurns ?? 0) > 0)) for (const m of s.members) m.cycleTurns = 0;
  s.roundIndex++;
  s.roundId = randomUUID();
  s.actorId = eligible[0].userId;
  s.targetId = null; s.question = null; s.revealAt = null;
  s.secret = null; s.votes = {}; s.outcome = null; s.voterIds = [];
  s.voteDeadline = null; s.originalVoteDeadline = null;
  s.storyPlayerIds = eligible.map(m => m.userId);
  if (s.cardRound) { s.cardRound = { order: eligible.map(m => m.userId), responses: {} }; s.targetId = s.cardRound.order[0]; }
  s.proposedGame = null; s.confirmedIds = []; s.nudgeAt = null; s.message = null;
  phase(s, s.game === 'cards' ? 'choosing_target' : 'secret_choice', now);
}
function finish(s: SocialState, now: number, completed: boolean): void {
  const actor = s.members.find(m => m.userId === s.actorId);
  if (actor) actor.turns++;
  if (actor && completed) actor.cycleTurns = (actor.cycleTurns ?? 0) + 1;
  if (completed) s.completed++;
  // An unrevealed reservation can be freed. Revealed/skipped families stay consumed.
  if (s.phase === 'revealing' && s.question) s.usedFamilies = s.usedFamilies.filter(f => f !== s.question!.familyId);
  s.secret = null; s.votes = {}; s.voteDeadline = null;
  s.question = null; s.outcome = null;
  phase(s, players(s, now, s.roundIndex + 1).length < 2 ? 'paused_insufficient_players' : 'between_rounds', now);
}
export function eligibleTargets(s: SocialState, now: number): SocialMember[] {
  const list = players(s, now).filter(m => m.userId !== s.actorId);
  const alternatives = list.filter(m => m.userId !== s.lastTargetId);
  return alternatives.length ? alternatives : list;
}
function deal(s: SocialState, bank: SocialQuestion[], history: Exposure[], now: number): void {
  const pair = s.cardRound?.order ?? [s.actorId, s.targetId];
  const viewers = s.members.filter(m => m.viewing).map(m => m.userId);
  const candidates = bank.filter(q => q.mode === s.mode && !s.usedFamilies.includes(q.familyId) &&
    (s.replayAllowed || !history.some(e => pair.includes(e.userId) && e.familyId === q.familyId)));
  if (!candidates.length) { s.question = null; phase(s, 'no_eligible_content', now); return; }
  const score = (q: SocialQuestion) => history.filter(e => viewers.includes(e.userId) && e.familyId === q.familyId)
    .reduce((n, e) => n + e.count, 0) * 10 + q.tags.reduce((n,t) => n + s.lastTags.filter(previous=>previous===t).length,0);
  const bestScore = Math.min(...candidates.map(score));
  const best = candidates.filter(q => score(q) === bestScore);
  s.question = best[randomInt(best.length)];
  s.exposedUsers = [];
  s.usedFamilies.push(s.question.familyId);
  s.revealAt = now + 850;
  phase(s, 'revealing', now);
}
/** Complete one turn without replacing the question everybody is answering. */
function completeCardTurn(s: SocialState, userId: string, response: 'answered' | 'passed', now: number): void {
  if (!s.cardRound || !s.cardRound.order.includes(userId) || s.cardRound.responses[userId]) return;
  s.cardRound.responses[userId] = response;
  const next = s.cardRound.order.find(id => !s.cardRound!.responses[id] &&
    s.members.some(m => m.userId === id && m.role === 'player'));
  s.targetId = next ?? null;
  if (!next) {
    const dealer = s.members.find(m => m.userId === s.actorId);
    if (dealer) { dealer.turns++; dealer.cycleTurns = (dealer.cycleTurns ?? 0) + 1; }
    s.completed++;
    phase(s, 'discussion', now);
  }
}
function missingTurn(s: SocialState, now: number): boolean {
  return s.members.some(m => (s.cardRound ? m.userId === s.targetId :
    m.userId === s.actorId || (s.game === 'cards' && m.userId === s.targetId)) && !connected(m, now));
}
export function applySocialCommand(s: SocialState, userId: string, cmd: SocialCommand, bank: SocialQuestion[], history: Exposure[], now: number): void {
  const m = s.members.find(p => p.userId === userId);
  if (cmd.action === 'pulse') {
    if (m) { m.lastSeen = now; m.disconnectedAt = null; if (typeof cmd.viewing === 'boolean') m.viewing = cmd.viewing; }
    return;
  }
  requireRule(s.phase !== 'ended' || cmd.action === 'restart', 'ended');
  if (cmd.action === 'join') {
    requireRule(cmd.role === 'player' || cmd.role === 'listener', 'invalid_role');
    requireRule(cmd.role !== 'player' || s.game !== 'cards' || s.mode !== 'closer' || cmd.consent === true, 'consent_required');
    const eligible = s.phase === 'preparing' || s.phase === 'between_rounds' || s.phase === 'paused_insufficient_players'
      ? s.roundIndex : s.roundIndex + 1;
    if (m) {
      if (m.role !== cmd.role) {
        if (s.cardRound && cmd.role === 'listener' && s.phase === 'answering') completeCardTurn(s, userId, 'passed', now);
        if (!s.cardRound && (m.userId === s.actorId || m.userId === s.targetId) && !['preparing', 'between_rounds', 'paused_insufficient_players', 'discussion'].includes(s.phase)) finish(s, now, false);
        m.eligibleFromRound = eligible;
        if (cmd.role === 'player') {
          const current = s.members.filter(p => p.role === 'player');
          if (current.length) m.turns = Math.max(m.turns, Math.min(...current.map(p => p.turns)));
        }
      }
      m.role = cmd.role!; m.lastSeen = now; m.disconnectedAt = null; m.viewing = true; m.closerConsent ||= cmd.consent === true;
    }
    else {
      const newcomer = member(userId, cmd.role!, eligible, cmd.consent === true, now);
      const currentPlayers = s.members.filter(p => p.role === 'player');
      newcomer.turns = currentPlayers.length ? Math.min(...currentPlayers.map(p => p.turns)) : 0;
      s.members.push(newcomer);
    }
    if (!s.hostId && cmd.role === 'player') s.hostId = userId;
    if (s.hostId === userId && cmd.role === 'listener') transferHost(s, now);
    return;
  }
  if (cmd.action === 'react') {
    requireRule(s.phase !== 'ended');
    requireRule(['حصل!', 'كمّل', 'ضحكتني'].includes(cmd.text ?? ''), 'invalid_reaction');
    requireRule(now - (s.cooldowns[`reaction:${userId}`] ?? 0) >= 1500, 'cooldown');
    s.cooldowns[`reaction:${userId}`] = now;
    s.reaction = { userId, text: cmd.text!, at: now };
    s.reactions=[...(s.reactions??[]).filter(r=>now-r.at<3000),s.reaction].slice(-6);
    return;
  }
  requireRule(m && connected(m, now), 'not_joined');
  const host = s.hostId === userId;
  const actor = s.actorId === userId;
  const target = s.targetId === userId;
  const managing = ['preparing', 'between_rounds', 'paused_insufficient_players', 'no_eligible_content', 'discussion'].includes(s.phase);
  const missingActor = missingTurn(s, now);
  if (cmd.action === 'leave' || cmd.action === 'listen') {
    if (cmd.action === 'leave') s.members = s.members.filter(p => p.userId !== userId);
    else m!.role = 'listener';
    if (s.cardRound && ['revealing', 'answering'].includes(s.phase)) {
      completeCardTurn(s, userId, 'passed', now);
    } else if ((actor || target) && !managing && s.phase !== 'discussion') {
      s.message = 'الدور اتعدّى'; finish(s, now, false);
    }
    if (host) transferHost(s, now);
    if (!s.members.length) { s.secret = null; s.votes = {}; s.outcome = null; phase(s, 'ended', now); }
    return;
  }
  if (cmd.action === 'end') {
    requireRule(host); s.secret = null; s.votes = {}; s.question = null; s.outcome = null;
    phase(s, 'ended', now); return;
  }
  if (cmd.action === 'mode') {
    requireRule(host && managing && s.game === 'cards');
    requireRule(['light', 'stories', 'closer'].includes(cmd.mode ?? ''), 'invalid_mode');
    requireRule(cmd.mode !== 'closer' || cmd.consent === true, 'consent_required');
    s.mode = cmd.mode!;
    if (s.mode === 'closer') {
      for (const p of s.members) if (!p.closerConsent) p.role = 'listener';
      if (cmd.consent === true) { m!.closerConsent = true; m!.role = 'player'; }
    }
    s.message = 'مود الأسئلة اتغيّر'; phase(s, 'between_rounds', now); return;
  }
  if (cmd.action === 'propose') {
    requireRule(host && managing);
    requireRule((cmd.game === 'cards' || cmd.game === 'truth') && cmd.game !== s.game, 'invalid_game');
    s.proposedGame = cmd.game!; s.confirmedIds = [userId]; return;
  }
  if (cmd.action === 'confirm') {
    requireRule(s.proposedGame && managing);
    if (!s.confirmedIds.includes(userId)) s.confirmedIds.push(userId); return;
  }
  if (cmd.action === 'cancelChange') {
    requireRule(host && managing && s.proposedGame);
    s.proposedGame = null; s.confirmedIds = []; return;
  }
  if (cmd.action === 'start' || cmd.action === 'advance') {
    requireRule(!s.proposedGame, 'confirm_game_change');
    requireRule((host && managing) || (s.phase === 'discussion' && (host || (actor && m!.role === 'player'))));
    requireRule(players(s, now, s.roundIndex + 1).length >= 2, 'need_players');
    nextRound(s, now);
    if (s.cardRound) deal(s, bank, history, now);
    return;
  }
  requireRule(!missingActor, 'waiting_reconnect');
  if (cmd.action === 'target') {
    requireRule(actor && s.phase === 'choosing_target');
    const targets = eligibleTargets(s, now);
    requireRule(targets.length, 'need_players');
    let pick = targets.find(p => p.userId === cmd.targetId);
    if (!cmd.targetId) {
      const score = (p: SocialMember) => p.targets * 100 + (s.pairs[`${userId}:${p.userId}`] ?? 0);
      const least = Math.min(...targets.map(score));
      const best = targets.filter(p => score(p) === least);
      pick = best[randomInt(best.length)];
    }
    requireRule(pick, 'invalid_target');
    s.targetId = pick!.userId; s.lastTargetId = pick!.userId; pick!.targets++;
    const key = `${userId}:${pick!.userId}`; s.pairs[key] = (s.pairs[key] ?? 0) + 1;
    deal(s, bank, history, now); return;
  }
  if (cmd.action === 'skip' || cmd.action === 'finish') {
    requireRule(target && s.phase === 'answering');
    if (s.cardRound) { completeCardTurn(s, userId, cmd.action === 'finish' ? 'answered' : 'passed', now); return; }
    if (cmd.action === 'finish') { finish(s, now, true); return; }
    requireRule(now - (s.cooldowns.skip ?? 0) >= 1500, 'cooldown');
    s.cooldowns.skip = now; s.roundId = randomUUID();
    s.message = 'ولا يهمك، ناخد غيره'; deal(s, bank, history, now); return;
  }
  if (cmd.action === 'override') {
    requireRule(host && !managing && s.phase !== 'discussion');
    requireRule(typeof cmd.text === 'string' && cmd.text.trim().length > 0 && cmd.text.length <= 120, 'reason_required');
    s.message = `الدور اتعدّى: ${cmd.text!.trim()}`;
    if (s.cardRound && s.phase === 'answering' && s.targetId) completeCardTurn(s, s.targetId, 'passed', now);
    else finish(s, now, false);
    return;
  }
  if (cmd.action === 'nudge') {
    requireRule(actor && s.phase === 'answering' && now - s.phaseAt >= 45_000);
    requireRule(now - (s.nudgeAt ?? 0) >= 15_000, 'cooldown');
    s.nudgeAt = now; return;
  }
  if (cmd.action === 'commit') {
    requireRule(actor && s.phase === 'secret_choice' && !s.secret);
    requireRule(cmd.choice === 'truth' || cmd.choice === 'fabrication', 'invalid_choice');
    s.secret = cmd.choice as 'truth' | 'fabrication'; phase(s, 'storytelling', now); return;
  }
  if (cmd.action === 'finishStory') {
    requireRule((actor || host) && s.phase === 'storytelling'); phase(s, 'questions', now); return;
  }
  if (cmd.action === 'openVoting') {
    requireRule((actor || host) && s.phase === 'questions');
    s.voterIds = s.storyPlayerIds.filter(id => id !== s.actorId && s.members.some(p => p.userId === id && p.role === 'player'));
    s.originalVoteDeadline = now + 20_000; s.voteDeadline = s.originalVoteDeadline;
    phase(s, 'voting', now); return;
  }
  if (cmd.action === 'vote') {
    requireRule(m!.role === 'player' && s.phase === 'voting' && now < s.voteDeadline! && s.voterIds.includes(userId), 'vote_closed');
    requireRule(['truth', 'fabrication', 'unsure'].includes(cmd.choice ?? ''), 'invalid_choice');
    s.votes[userId] = cmd.choice!;
    if (s.voterIds.every(id => s.votes[id])) s.voteDeadline = Math.min(s.voteDeadline!, now + 3000);
    return;
  }
  throw new SocialRuleError('invalid_action');
}
function transferHost(s: SocialState, now: number): void {
  const next = s.members.filter(m => m.role === 'player' && connected(m, now))
    .sort((a, b) => a.joinedAt - b.joinedAt || a.userId.localeCompare(b.userId))[0];
  s.hostId = next?.userId ?? null;
}
export function tickSocialState(s: SocialState, now: number): boolean {
  if (s.phase === 'ended') return false;
  let changed = false;
  const gone = s.members.filter(m => expired(m, now));
  const actorGone = gone.some(m => m.userId === s.actorId || (s.game === 'cards' && m.userId === s.targetId));
  if (gone.length) {
    s.members = s.members.filter(m => !expired(m, now));
    if (s.cardRound && ['revealing', 'answering'].includes(s.phase)) {
      for (const m of gone) completeCardTurn(s, m.userId, 'passed', now);
    } else if (actorGone && !['preparing', 'between_rounds', 'discussion', 'paused_insufficient_players', 'no_eligible_content'].includes(s.phase)) {
      s.message = 'الدور اتلغى عشان الاتصال'; finish(s, now, false);
    }
    changed = true;
  }
  if (!s.members.length) { s.secret = null; s.votes = {}; s.outcome = null; phase(s, 'ended', now); return true; }
  if (!s.members.some(m => m.userId === s.hostId && m.role === 'player')) {
    const previous = s.hostId; transferHost(s, now); changed ||= previous !== s.hostId;
  }
  if (!s.members.some(m => m.role === 'player') && now - s.phaseAt > SOCIAL_RECONNECT_MS) {
    s.secret = null; s.votes = {}; s.outcome = null; s.question = null; phase(s, 'ended', now); return true;
  }
  const absent = missingTurn(s, now);
  if (absent) return changed;
  if (s.phase === 'revealing' && now >= s.revealAt!) { phase(s, 'answering', now); s.lastTags = [...s.lastTags,...(s.question?.tags ?? [])].slice(-3); changed = true; }
  if (s.phase === 'voting' && now >= s.voteDeadline!) {
    const votes = s.voterIds.map(userId => {
      const choice = s.votes[userId] ?? null;
      const result = choice === null ? 'no_response' as const : choice === 'unsure' ? 'abstained' as const :
        choice === s.secret ? 'correct' as const : 'incorrect' as const;
      return { userId, choice, result };
    });
    s.outcome = { choice: s.secret!, votes, correct: votes.filter(v => v.result === 'correct').length,
      fooled: votes.filter(v => v.result === 'incorrect').length,
      guesses: votes.filter(v => v.result === 'correct' || v.result === 'incorrect').length,
      abstained: votes.filter(v => v.result === 'abstained').length,
      noResponse: votes.filter(v => v.result === 'no_response').length };
    s.revealAt = now + 900; phase(s, 'reveal', now); changed = true;
  }
  if (s.phase === 'reveal' && now >= s.revealAt!) {
    const storyteller = s.members.find(m => m.userId === s.actorId);
    if (storyteller) { storyteller.turns++; storyteller.cycleTurns = (storyteller.cycleTurns ?? 0) + 1; }
    s.completed++; phase(s, 'discussion', now); changed = true;
  }
  return changed;
}
export function socialSnapshot(s: SocialState | null, squadId: string, userId: string, now: number, enabled = true): SocialSnapshot {
  const empty: SocialSnapshot = { enabled, serverNow: now, squadId, session: null, personal: { choice: null, vote: null, allowed: [], targetIds: [] } };
  if (!s) return empty;
  const me = s.members.find(m => m.userId === userId);
  const host = s.hostId === userId;
  const actor = s.actorId === userId;
  const target = s.targetId === userId;
  const managing = ['preparing', 'between_rounds', 'paused_insufficient_players', 'no_eligible_content', 'discussion'].includes(s.phase);
  const live = s.phase !== 'ended';
  const outcomeVisible = s.phase === 'discussion';
  const allowed = live ? ['join', 'react'] : host ? ['restart'] : [];
  if (me && live && connected(me, now)) {
    allowed.push('leave', 'listen');
    if (host) allowed.push('end');
    if (host && managing) allowed.push(...(s.game === 'cards' ? ['mode'] : []), 'propose',
      ...(s.proposedGame ? ['cancelChange', ...(s.confirmedIds.filter(id=>s.members.some(m=>m.userId===id&&connected(m,now))).length>=2 ? ['switch'] : [])]
        : players(s,now,s.roundIndex+1).length>=2 && s.phase !== 'no_eligible_content' ? ['start'] : []));
    if (host && s.phase === 'no_eligible_content') allowed.push('restart');
    if (s.proposedGame && managing) allowed.push('confirm');
    const waiting = missingTurn(s, now);
    if (!waiting) {
      if (actor && s.phase === 'choosing_target') allowed.push('target');
      if (target && s.phase === 'answering') allowed.push('skip', 'finish');
      if (actor && s.phase === 'answering' && now - s.phaseAt >= 45_000) allowed.push('nudge');
      if (host && !managing && s.phase !== 'discussion') allowed.push('override');
      if (actor && s.phase === 'secret_choice') allowed.push('commit');
      if ((actor || host) && s.phase === 'storytelling') allowed.push('finishStory');
      if ((actor || host) && s.phase === 'questions') allowed.push('openVoting');
      if (me.role === 'player' && s.phase === 'voting' && now < s.voteDeadline! && s.voterIds.includes(userId)) allowed.push('vote');
      if (s.phase === 'discussion' && ((actor && me.role === 'player') || host) && !s.proposedGame) allowed.push('advance');
    }
  }
  return { ...empty,
    session: { id: s.id, game: s.game, mode: s.mode, phase: s.phase, revision: s.revision,
      hostId: s.hostId, roundId: s.roundId, roundIndex: s.roundIndex, actorId: s.actorId, targetId: s.targetId,
      ...(s.cardRound ? { cardRound: { order: [...s.cardRound.order], responses: { ...s.cardRound.responses } } } : {}),
      members: s.members.map(m => ({ userId: m.userId, role: m.role, connected: connected(m, now), waiting: m.eligibleFromRound > s.roundIndex })),
      question: (s.phase === 'answering' || (s.cardRound && s.phase === 'discussion')) && s.question ? { id: s.question.id, text: s.question.text, mode: s.question.mode } : null,
      revealAt: s.revealAt, voteDeadline: s.voteDeadline, phaseAt: s.phaseAt,
      voterIds: [...s.voterIds], submittedIds: s.voterIds.filter(id => s.votes[id]),
      outcome: outcomeVisible ? s.outcome : null, completed: s.completed, message: s.message,
      proposedGame: s.proposedGame, confirmedIds: [...s.confirmedIds],
      reaction: s.reaction && now - s.reaction.at < 1400 ? s.reaction : null, nudgeAt: s.nudgeAt,
      reactions:(s.reactions??(s.reaction?[s.reaction]:[])).filter(r=>now-r.at<3000).slice(-6).map(r=>({...r})),
      cycleComplete: s.members.some(m => m.role === 'player') && s.members.filter(m => m.role === 'player').every(m => (m.cycleTurns ?? 0) > 0),
    },
    personal: { choice: me && actor ? s.secret : null, vote: me ? s.votes[userId] ?? null : null,
      allowed, targetIds: actor && s.phase === 'choosing_target' ? eligibleTargets(s, now).map(m => m.userId) : [] },
  };
}
