import { playBotMatch } from './camo-sim';

describe('camo simulation', () => {
  jest.setTimeout(600_000);

  it('plays 60 bot-only classic matches to the end with every invariant intact', () => {
    const problems: string[] = [];
    let rounds = 0;
    let reds = 0;
    let yellows = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const r = playBotMatch(seed, { players: 4 + (seed % 7) });
      problems.push(...r.violations.map((v) => `seed ${seed}: ${v}`));
      rounds += r.match.rounds.length;
      for (const e of r.events) if (e.t === 'card') e.kind === 'red' ? reds++ : yellows++;
      if (r.match.rounds.length !== 3) problems.push(`seed ${seed}: ${r.match.rounds.length} rounds`);
    }
    expect(problems).toEqual([]);
    expect(rounds).toBe(180);
    expect(reds).toBeGreaterThan(60);
    expect(yellows).toBeGreaterThan(30);
  });

  it('plays contagion matches too', () => {
    for (let seed = 100; seed < 112; seed++) {
      const r = playBotMatch(seed, { mode: 'contagion', players: 8 });
      expect(r.violations).toEqual([]);
      expect(r.match.rounds.length).toBe(3);
    }
  });

  it('is deterministic for a seed', () => {
    const a = playBotMatch(9);
    const b = playBotMatch(9);
    expect(JSON.stringify(a.match.rounds.map((r) => [r.winner, r.points]))).toBe(JSON.stringify(b.match.rounds.map((r) => [r.winner, r.points])));
    expect(a.ticks).toBe(b.ticks);
  });

  it('does not leave anything armed after the match (no pending outbox, ended phase)', () => {
    const r = playBotMatch(5);
    expect(r.match.phase).toBe('ended');
    expect(r.match.outbox.length).toBe(0);
  });
});
