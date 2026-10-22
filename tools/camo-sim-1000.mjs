// The 1000-match bot simulation of section 19: every invariant checked, balance numbers printed. Run once per milestone.
// Usage: node tools/camo-sim-1000.mjs [matches=1000]   (needs `npm run build` first)
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { playBotMatch } = require('../dist/src/modules/camo/camo-sim.js');
const N = Number(process.argv[2] || 1000);
const t0 = Date.now();
let problems = [], rounds = 0, reds = 0, yellows = 0, hidersWon = 0, seekersWon = 0, survived = [];
const perRoom = {};
for (let seed = 1; seed <= N; seed++) {
  const mode = seed % 5 === 0 ? 'contagion' : 'classic';
  const r = playBotMatch(seed, { players: 4 + (seed % 7), mode });
  for (const v of r.violations) problems.push(`seed ${seed}: ${v}`);
  if (r.match.rounds.length !== 3) problems.push(`seed ${seed}: ${r.match.rounds.length} rounds`);
  rounds += r.match.rounds.length;
  for (const rd of r.match.rounds) rd.winner === 'hiders' ? hidersWon++ : seekersWon++;
  for (const e of r.events) if (e.t === 'card') e.kind === 'red' ? reds++ : yellows++;
}
const out = { matches: N, seconds: Math.round((Date.now() - t0) / 1000), violations: problems.length, firstProblems: problems.slice(0, 5), rounds, hidersWonPct: +(100 * hidersWon / rounds).toFixed(1), redsPerRound: +(reds / rounds).toFixed(2), yellowsPerRound: +(yellows / rounds).toFixed(2) };
console.log(JSON.stringify(out));
process.exit(problems.length ? 1 : 0);
