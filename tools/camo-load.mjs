// Load check for the camo host (no sockets, no database): N matches of 8 people each running in real time.
// Prints tick cost percentiles, messages and bytes per second per player, and memory. Usage: node tools/camo-load.mjs [matches=40] [seconds=60]
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { CamoHost } = require('../dist/src/modules/camo/camo-host.js');
const N = Number(process.argv[2] || 40);
const SECONDS = Number(process.argv[3] || 60);
let msgs = 0, bytes = 0, volatileMsgs = 0;
const sink = { emit: (_u, _e, p, v) => { msgs++; if (v) volatileMsgs++; try { bytes += JSON.stringify(p)?.length ?? 0; } catch { bytes += 64; } } };
const host = new CamoHost({ maxMatches: N + 5, now: () => Date.now(), sink, waitMs: 0 });
let uid = 0;
for (let m = 0; m < N; m++) {
  const first = { userId: `u${++uid}`, name: `P${uid}`, morphId: 'potato', guest: false };
  const made = host.createPrivate(first, { bots: 0 });
  for (let i = 1; i < 8; i++) host.joinPrivate({ userId: `u${++uid}`, name: `P${uid}`, morphId: 'banana', guest: false }, host.matchOf(first.userId).code);
  host.hostStart(first.userId);
}
const ticks = [];
const orig = host.tick.bind(host);
host.tick = (now) => { const t0 = process.hrtime.bigint(); orig(now); ticks.push(Number(process.hrtime.bigint() - t0) / 1e6); };
host.start();
const rss0 = process.memoryUsage().rss;
// every human wiggles like a real client so the AFK cover does not kick in
const wiggle = setInterval(() => { for (const m of host.matches.values()) for (const p of m.players) if (!p.isBot) p.lastInputAt = Date.now(); }, 1000);
await new Promise((r) => setTimeout(r, SECONDS * 1000));
clearInterval(wiggle);
host.dispose();
ticks.sort((a, b) => a - b);
const q = (p) => ticks[Math.min(ticks.length - 1, Math.floor(ticks.length * p))]?.toFixed(2);
const players = N * 8;
console.log(JSON.stringify({ matches: N, players, seconds: SECONDS, ticks: ticks.length, tickMs: { p50: q(0.5), p95: q(0.95), p99: q(0.99), max: ticks.at(-1)?.toFixed(2) }, msgsPerSecPerPlayer: +(msgs / SECONDS / players).toFixed(1), kbPerSecPerPlayer: +(bytes / 1024 / SECONDS / players).toFixed(2), volatileShare: +(volatileMsgs / msgs).toFixed(2), rssMB: Math.round(process.memoryUsage().rss / 1048576), rssGrowthMB: Math.round((process.memoryUsage().rss - rss0) / 1048576) }));
process.exit(0);
