import {
  ENDED_MS,
  MAX_SUDDEN_DEATH_ROUNDS,
  RESULT_MS,
  SETUP_MS,
  advance,
  beginAim,
  beginDive,
  beginFlight,
  cancel,
  clampToBox,
  createPenalty,
  decidedEarly,
  divePose,
  penaltyView,
  removePlayer,
  resolveShot,
  roundsFor,
  type PenaltyOutcome,
  type PenaltyState,
} from './penalty-rules';

const T = 1_000_000;

function kick(s: PenaltyState, outcome: PenaltyOutcome): void {
  beginAim(s, T);
  beginFlight(s, T);
  resolveShot(s, outcome, T);
  advance(s, T);
}

describe('penalty rules', () => {
  it('accepts one keeper dive per shot and follows a bounded 450ms arc', () => {
    const s = createPenalty('sq', 'a', ['a', 'b'], T)!;
    expect(beginDive(s, 'b', 1, 0, -6.65, T)).toBe(false);
    beginAim(s, T);
    expect(beginDive(s, 'a', 1, 0, -6.65, T)).toBe(false);
    expect(beginDive(s, 'b', 2, 0, -6.65, T)).toBe(false);
    expect(beginDive(s, 'b', -1, 0, -6.65, T)).toBe(true);
    expect(beginDive(s, 'b', 1, 0, -6.65, T)).toBe(false);
    expect(divePose(s.dive!, T).x).toBe(0);
    expect(divePose(s.dive!, T + 450).x).toBe(-1.4);
    expect(divePose(s.dive!, T + 500).locked).toBe(true);
    expect(divePose(s.dive!, T + 1050).locked).toBe(false);
    expect(divePose(s.dive!, T + 100).r).toBe(0.55);
    beginFlight(s, T);
    expect(beginDive(s, 'b', 0, 0, -6.65, T)).toBe(false);
    resolveShot(s, 'missed', T);
    advance(s, T);
    expect(s.dive).toBeNull();
  });

  it('centre block stays on the line', () => {
    const s = createPenalty('sq', 'a', ['a', 'b'], T)!;
    beginAim(s, T);
    expect(beginDive(s, 'b', 0, 0.2, -6.65, T)).toBe(true);
    expect(divePose(s.dive!, T + 450).x).toBe(0.2);
  });
  it('needs two different players and caps the squad at six', () => {
    expect(createPenalty('sq', 'a', ['a'], T)).toBeNull();
    expect(createPenalty('sq', 'a', ['a', 'a'], T)).toBeNull();
    const s = createPenalty('sq', 'a', ['a', 'b', 'c', 'd', 'e', 'f', 'g'], T)!;
    expect(s.order).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(s.rounds).toBe(3);
    expect(roundsFor(2)).toBe(5);
  });

  it('starts with the requester shooting and the next player in goal, walking to the spots', () => {
    const s = createPenalty('sq', 'a', ['a', 'b', 'c'], T)!;
    expect([s.shooterId, s.keeperId, s.phase, s.phaseUntil]).toEqual([
      'a',
      'b',
      'setup',
      T + SETUP_MS,
    ]);
  });

  it('rotates: everybody shoots in order and keeps goal in turn, never against themselves', () => {
    const s = createPenalty('sq', 'a', ['a', 'b', 'c'], T)!;
    const pairs: string[] = [];
    for (let i = 0; i < 6; i++) {
      pairs.push(s.shooterId + s.keeperId);
      kick(s, 'missed');
    }
    expect(pairs).toEqual(['ab', 'bc', 'ca', 'ab', 'bc', 'ca']);
  });

  it('scores goals only, keeps every outcome, and shows the result before moving on', () => {
    const s = createPenalty('sq', 'a', ['a', 'b'], T)!;
    beginAim(s, T);
    beginFlight(s, T);
    resolveShot(s, 'goal', T);
    expect(s.phase).toBe('result');
    expect(s.phaseUntil).toBe(T + RESULT_MS);
    expect(s.goals).toEqual({ a: 1, b: 0 });
    expect(s.lastOutcome).toBe('goal');
    expect(s.lastShooterId).toBe('a');
    advance(s, T);
    expect(s.shooterId).toBe('b');
    kick(s, 'saved');
    expect(s.shots).toEqual({ a: ['goal'], b: ['saved'] });
  });

  it('ends early once nobody can catch the leader', () => {
    const s = createPenalty('sq', 'a', ['a', 'b'], T)!;
    // a scores 3, b misses 3: b has 2 kicks left, can reach at most 2 < 3.
    for (let i = 0; i < 3; i++) {
      kick(s, 'goal');
      if (s.phase !== 'ended') kick(s, 'missed');
    }
    expect(s.phase).toBe('ended');
    expect(s.winners).toEqual(['a']);
    expect(s.phaseUntil).toBe(T + ENDED_MS);
  });

  it('does not end early while the trailing player can still level', () => {
    const s = createPenalty('sq', 'a', ['a', 'b'], T)!;
    kick(s, 'goal'); // a 1 - 0, b still has all 5
    expect(decidedEarly(s)).toBe(false);
    expect(s.phase).toBe('setup');
  });

  it('level after the regular kicks: sudden death between the tied players only', () => {
    const s = createPenalty('sq', 'a', ['a', 'b', 'c', 'd'], T)!;
    for (let i = 0; i < 12 && s.suddenDeath === 0; i++)
      kick(s, s.shooterId === 'a' || s.shooterId === 'b' ? 'goal' : 'missed');
    expect(s.suddenDeath).toBe(1);
    expect(s.kickers).toEqual(['a', 'b']);
    expect(s.shooterId).toBe('a');
    kick(s, 'goal');
    kick(s, 'saved'); // b misses: a wins
    expect(s.phase).toBe('ended');
    expect(s.winners).toEqual(['a']);
  });

  it('a shootout still level after the sudden-death limit is shared', () => {
    const s = createPenalty('sq', 'a', ['a', 'b'], T)!;
    for (let i = 0; i < 10; i++) kick(s, 'goal');
    for (let r = 0; r < MAX_SUDDEN_DEATH_ROUNDS; r++) {
      kick(s, 'goal');
      kick(s, 'goal');
    }
    expect(s.phase).toBe('ended');
    expect(s.winners.sort()).toEqual(['a', 'b']);
  });

  it('a player leaving: the pair is replaced, fewer than two ends it without a winner', () => {
    const s = createPenalty('sq', 'a', ['a', 'b', 'c'], T)!;
    beginAim(s, T);
    removePlayer(s, 'b', T + 10); // the keeper
    expect(s.order).toEqual(['a', 'c']);
    expect([s.shooterId, s.keeperId, s.phase]).toEqual(['a', 'c', 'setup']);
    removePlayer(s, 'c', T + 20);
    expect(s.phase).toBe('ended');
    expect(s.cancelled).toBe(true);
    expect(s.winners).toEqual([]);
  });

  it('cancel ends at once; the public view is a copy', () => {
    const s = createPenalty('sq', 'a', ['a', 'b'], T)!;
    const v = penaltyView(s, T);
    v.goals['a'] = 99;
    expect(s.goals['a']).toBe(0);
    cancel(s, T);
    expect([s.phase, s.cancelled]).toEqual(['ended', true]);
  });

  it('clampToBox returns the corrected point, or null inside', () => {
    const box = { minX: -1, maxX: 1, minZ: -2, maxZ: 2 };
    expect(clampToBox(0, 0, box)).toBeNull();
    expect(clampToBox(3, -5, box)).toEqual({ x: 1, z: -2 });
  });
});
