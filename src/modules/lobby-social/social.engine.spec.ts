import { applySocialCommand, createSocialState, socialSnapshot, tickSocialState } from './social.engine';
import { SOCIAL_QUESTIONS } from './social.questions';
import { SocialCommand, SocialState } from './social.types';

describe('Social games authoritative rules', () => {
  let now: number;
  let s: SocialState;
  const act = (id: string, action: string, extra: Partial<SocialCommand> = {}) => applySocialCommand(s, id,
    { squadId: 'room', action, requestId: `${id}-${now}`, ...extra }, SOCIAL_QUESTIONS, [], now);
  const setup = (game: 'cards' | 'truth' = 'cards') => {
    now = 100_000;
    s = createSocialState('room', 'a', { squadId: 'room', requestId: 'create', action: 'create', game }, now);
    delete s.cardRound; // Legacy stored-session compatibility. New shared rounds have their own suite.
    act('b', 'join', { role: 'player' });
    act('c', 'join', { role: 'player' });
    act('d', 'join', { role: 'listener' });
  };
  const revealCard = () => { act('a', 'start'); act('a', 'target', { targetId: 'b' }); now += 900; tickSocialState(s, now); };
  const voting = () => { setup('truth'); act('a', 'start'); act('a', 'commit', { choice: 'fabrication' }); act('a', 'finishStory'); act('a', 'openVoting'); };
  beforeEach(() => setup());

  it('keeps overlapping room reactions bounded and expires them without losing earlier senders',()=>{
    act('a','react',{text:'حصل!'});act('b','react',{text:'ضحكتني'});
    expect(socialSnapshot(s,'room','c',now).session!.reactions?.map(r=>r.userId)).toEqual(['a','b']);
    for(let i=0;i<8;i++)act(`spectator-${i}`,'react',{text:'كمّل'});
    expect(socialSnapshot(s,'room','c',now).session!.reactions).toHaveLength(6);
    now+=3001;expect(socialSnapshot(s,'room','c',now).session!.reactions).toEqual([]);
    delete s.reactions;s.reaction={userId:'a',text:'حصل!',at:now};
    expect(socialSnapshot(s,'room','c',now).session!.reactions).toHaveLength(1);
  });

  it('lets an authenticated room spectator react without enrolling or gaining player controls', () => {
    expect(socialSnapshot(s,'room','spectator',now).personal.allowed).toContain('react');
    act('spectator','react',{text:'ضحكتني'});
    expect(s.reaction?.userId).toBe('spectator');
    expect(s.members.some(m=>m.userId==='spectator')).toBe(false);
    expect(()=>act('spectator','start')).toThrow('not_joined');
    expect(()=>act('spectator','react',{text:'حصل!'})).toThrow('cooldown');
  });

  it('requires two players, listeners do not count', () => {
    s.members = s.members.filter(m => m.userId === 'a' || m.userId === 'd');
    expect(() => act('a', 'start')).toThrow('need_players');
  });
  it('locks the target in one action and does not send question before reveal', () => {
    act('a', 'start'); act('a', 'target', { targetId: 'b' });
    expect(socialSnapshot(s, 'room', 'c', now).session!.question).toBeNull();
    expect(() => act('a', 'target', { targetId: 'c' })).toThrow();
    now += 900; tickSocialState(s, now);
    expect(socialSnapshot(s, 'room', 'c', now).session!.question!.text).toBe(s.question!.text);
  });
  it('rejects self and listener targets', () => {
    act('a', 'start');
    expect(() => act('a', 'target', { targetId: 'a' })).toThrow('invalid_target');
    expect(() => act('a', 'target', { targetId: 'd' })).toThrow('invalid_target');
  });
  it('skip consumes a family, has cooldown and retains pair', () => {
    revealCard(); const original = s.question!.familyId;
    act('b', 'skip'); expect(s.targetId).toBe('b'); expect(s.usedFamilies).toContain(original);
    expect(s.question!.familyId).not.toBe(original);
    now += 900; tickSocialState(s, now); expect(() => act('b', 'skip')).toThrow('cooldown');
  });
  it('uses family identity rather than question identity and shows explicit exhaustion', () => {
    act('a', 'start'); act('a', 'target', { targetId: 'b' });
    s.usedFamilies = SOCIAL_QUESTIONS.map(q => q.familyId); now += 900; tickSocialState(s, now);
    act('b', 'skip'); expect(s.phase).toBe('no_eligible_content'); expect(s.question).toBeNull();
  });
  it('history excludes both participants and prefers unexposed audience content', () => {
    act('a', 'start');
    const q = SOCIAL_QUESTIONS.find(q => q.mode === 'light')!;
    applySocialCommand(s, 'a', { squadId: 'room', requestId: 'target', action: 'target', targetId: 'b' },
      [q], [{ userId: 'b', familyId: q.familyId, count: 1 }], now);
    expect(s.phase).toBe('no_eligible_content');
  });
  it('keeps joins during a round out of current roles', () => {
    revealCard(); act('e', 'join', { role: 'player' });
    expect(socialSnapshot(s, 'room', 'e', now).session!.members.find(m => m.userId === 'e')!.waiting).toBe(true);
    expect(() => act('e', 'finish')).toThrow();
  });
  it('joining again preserves current eligibility', () => {
    act('a', 'start'); act('b', 'join', { role: 'player' });
    expect(socialSnapshot(s, 'room', 'a', now).personal.targetIds).toContain('b');
  });
  it('rotates askers without blocking a two-person game', () => {
    s.members = s.members.filter(m => m.userId !== 'c');
    revealCard(); act('b', 'finish'); act('a', 'advance');
    expect(s.actorId).toBe('b'); act('b', 'target'); expect(s.targetId).toBe('a');
  });
  it('listener mode cancels a current pair without touching external services', () => {
    revealCard(); act('b', 'listen'); expect(s.phase).toBe('between_rounds');
    expect(s.members.find(m => m.userId === 'b')!.role).toBe('listener');
  });
  it('preserves round during grace and cancels after expiry', () => {
    revealCard(); const id = s.roundId; const family = s.question!.familyId;
    now += 20_000; act('a', 'pulse'); act('c', 'pulse'); tickSocialState(s, now);
    expect(s.roundId).toBe(id); expect(() => act('a', 'override', { text: 'تعطل' })).toThrow('waiting_reconnect');
    now += 26_000; act('a', 'pulse'); act('c', 'pulse'); tickSocialState(s, now);
    expect(s.phase).toBe('between_rounds'); expect(s.usedFamilies).toContain(family);
  });
  it('transfers expired host once and does not restore on return', () => {
    now += 46_000; act('b', 'pulse'); act('c', 'pulse'); tickSocialState(s, now);
    expect(s.hostId).toBe('b'); act('a', 'join', { role: 'player' }); expect(s.hostId).toBe('b');
  });
  it('requires explicit consent for closer mode', () => {
    act('a', 'mode', { mode: 'closer', consent: true });
    expect(() => act('b', 'join', { role: 'player' })).toThrow('consent_required');
    expect(() => act('a', 'start')).toThrow('need_players');
  });
  it('does not disclose choice to host, audience or listeners before collective reveal', () => {
    voting();
    for (const id of ['b', 'c', 'd', '']) {
      const json = JSON.stringify(socialSnapshot(s, 'room', id, now));
      expect(json).not.toContain('fabrication'); expect(json).not.toContain('secret');
    }
    expect(socialSnapshot(s, 'room', 'a', now).personal.choice).toBe('fabrication');
    expect(() => act('a', 'commit', { choice: 'truth' })).toThrow();
  });
  it('keeps votes private, editable and closes once with bounded grace', () => {
    voting(); const original = s.voteDeadline!;
    act('b', 'vote', { choice: 'truth' }); act('c', 'vote', { choice: 'unsure' });
    const deadline = s.voteDeadline!; expect(deadline).toBe(now + 3000);
    now += 1000; act('b', 'vote', { choice: 'fabrication' }); expect(s.voteDeadline).toBe(deadline);
    expect(socialSnapshot(s, 'room', 'c', now).personal.vote).toBe('unsure');
    expect(socialSnapshot(s, 'room', 'c', now).session!.outcome).toBeNull();
    now = deadline; tickSocialState(s, now); expect(s.phase).toBe('reveal');
    expect(socialSnapshot(s, 'room', 'b', now).session!.outcome).toBeNull();
    now += 901; tickSocialState(s, now); expect(s.outcome!.correct).toBe(1);
    expect(s.outcome!.abstained).toBe(1); expect(s.outcome!.guesses).toBe(1);
    expect(() => act('b', 'vote', { choice: 'truth' })).toThrow('vote_closed');
    expect(deadline).toBeLessThan(original);
  });
  it('never extends original voting deadline for late final vote', () => {
    voting(); const deadline = s.voteDeadline!;
    now += 18_000; act('a', 'pulse'); act('b', 'pulse'); act('c', 'pulse');
    act('b', 'vote', { choice: 'truth' }); act('c', 'vote', { choice: 'truth' }); expect(s.voteDeadline).toBe(deadline);
  });
  it('does not allow audience or mid-story join to vote', () => {
    voting(); act('e', 'join', { role: 'player' });
    expect(() => act('d', 'vote', { choice: 'truth' })).toThrow('vote_closed');
    expect(() => act('e', 'vote', { choice: 'truth' })).toThrow('vote_closed');
  });
  it('cancels storyteller departure without result disclosure', () => {
    voting(); act('b', 'vote', { choice: 'truth' }); act('a', 'leave');
    expect(s.secret).toBeNull(); expect(s.outcome).toBeNull(); expect(s.phase).toBe('between_rounds');
    expect(socialSnapshot(s, 'room', 'b', now).session!.outcome).toBeNull();
  });
  it('retains disconnected voter submission and accounts separately for no response', () => {
    voting(); act('b', 'vote', { choice: 'truth' }); now += 20_000; act('a', 'pulse');
    tickSocialState(s, now); now += 900; tickSocialState(s, now);
    expect(s.outcome!.fooled).toBe(1); expect(s.outcome!.noResponse).toBe(1);
  });
  it('supports round with zero guesses and no score or division', () => {
    voting(); act('b', 'vote', { choice: 'unsure' }); act('c', 'vote', { choice: 'unsure' });
    now += 3000; tickSocialState(s, now); now += 900; tickSocialState(s, now);
    expect(s.outcome!.guesses).toBe(0); expect(s.outcome!.correct).toBe(0);
  });
  it('advances truth storyteller fairly after discussion', () => {
    voting(); now += 20_000; act('a', 'pulse'); act('b', 'pulse'); act('c', 'pulse');
    tickSocialState(s, now); now += 900; tickSocialState(s, now); act('a', 'advance');
    expect(s.actorId).toBe('b'); expect(s.completed).toBe(1);
  });
  it('has 180 unique questions, shared semantic families, 60 per mode, human review pending', () => {
    expect(SOCIAL_QUESTIONS).toHaveLength(180);
    expect(new Set(SOCIAL_QUESTIONS.map(q => q.id)).size).toBe(180);
    expect(new Set(SOCIAL_QUESTIONS.map(q => q.familyId)).size).toBe(179);
    for (const mode of ['light', 'stories', 'closer']) expect(SOCIAL_QUESTIONS.filter(q => q.mode === mode)).toHaveLength(60);
    expect(SOCIAL_QUESTIONS.every(q => q.status === 'draft' && q.reviewedAt === null)).toBe(true);
    for(const mode of ['light','stories','closer']) expect(new Set(SOCIAL_QUESTIONS.filter(q=>q.mode===mode).flatMap(q=>q.tags)).size).toBeGreaterThanOrEqual(5);
  });
  it('puts a late newcomer behind the people already waiting, even after several cycles', () => {
    s.members.find(m=>m.userId==='a')!.turns=4;
    s.members.find(m=>m.userId==='b')!.turns=3;
    s.members.find(m=>m.userId==='c')!.turns=3;
    act('a','start'); now++;
    act('e','join',{role:'player'});
    expect(s.members.find(m=>m.userId==='e')!.turns).toBe(3);
    act('a','override',{text:'تعطل'});act('a','advance');expect(s.actorId).toBe('c');
  });
  it('counts a revealed story before ending, and begins a fresh cycle after everybody has told one', () => {
    voting();
    s.members.filter(m=>m.userId!=='a'&&m.role==='player').forEach(m=>m.cycleTurns=1);
    now+=20_000;act('a','pulse');act('b','pulse');act('c','pulse');tickSocialState(s,now);
    now+=900;tickSocialState(s,now);
    expect(s.completed).toBe(1);expect(socialSnapshot(s,'room','a',now).session!.cycleComplete).toBe(true);
    act('a','advance');expect(socialSnapshot(s,'room','a',now).session!.cycleComplete).toBe(false);
  });
  it('does not let somebody becoming a listener change an already frozen vote', () => {
    voting();act('b','vote',{choice:'truth'});act('b','listen');
    expect(s.votes.b).toBe('truth');expect(s.voterIds).toContain('b');
    expect(()=>act('b','vote',{choice:'fabrication'})).toThrow('vote_closed');
  });
  it('supports change confirmation and cancellation during truth discussion', () => {
    voting();now+=20_000;act('a','pulse');act('b','pulse');act('d','pulse');tickSocialState(s,now);now+=900;tickSocialState(s,now);
    act('a','propose',{game:'cards'});act('d','confirm');
    expect(s.confirmedIds).toContain('d');
    expect(()=>act('a','advance')).toThrow('confirm_game_change');
    act('a','cancelChange');expect(s.proposedGame).toBeNull();
  });
  it('starts the reconnect grace at the actual disconnect event', () => {
    revealCard();s.members.find(m=>m.userId==='b')!.disconnectedAt=now;
    expect(socialSnapshot(s,'room','b',now).personal.allowed).not.toContain('skip');
    now+=30_001;act('a','pulse');act('c','pulse');tickSocialState(s,now);
    expect(s.phase).toBe('between_rounds');
  });
  it('does not retain a ghost session with only listeners', () => {
    act('a','listen');act('b','listen');act('c','listen');
    now+=30_001;for(const m of s.members)act(m.userId,'pulse');tickSocialState(s,now);
    expect(s.phase).toBe('ended');expect(s.secret).toBeNull();
  });
});
