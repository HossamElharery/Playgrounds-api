// Moderation smoke over real sockets: private room, host mute, a report with context, and a vote (scratch DB).
import { io } from '/Users/hossamelharery/Documents/Playgrounds/angular/node_modules/socket.io-client/build/esm/index.js';
import { execFileSync } from 'node:child_process';
const API = process.env.API || 'http://localhost:3050';
const DB = process.env.CAMO_DB || 'camo_scratch_20261022';
const post = async (path, token, body) => (await fetch(`${API}/api/v1${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body ?? {}) })).json();
const ack = (s, ev, body) => new Promise((res) => s.emit(ev, body, res));
const players = [];
for (let i = 1; i <= 4; i++) {
  if (i > 1) await new Promise((r) => setTimeout(r, 21_000)); // guest/play is throttled to 3 per minute per IP
  const j = await post('/auth/guest/play', null, { name: `Mod${i}`, deviceId: `mod-${Date.now()}-${i}` });
  const s = io(API, { auth: { token: j.result.accessToken }, transports: ['websocket'] });
  const p = { id: j.result.user.id, name: `Mod${i}`, socket: s, events: [] };
  s.onAny((e, d) => p.events.push([e, d]));
  await new Promise((r) => s.on('connect', r));
  await new Promise((r) => setTimeout(r, 400));
  await ack(s, 'camo.hello', { protocolVersion: 1 });
  players.push(p);
}
const [H, B, C, D] = players;
const made = await ack(H.socket, 'camo.private.create', { bots: 2 }); console.log('create', JSON.stringify(made));
for (const p of [B, C, D]) console.log('join', p.name, JSON.stringify(await ack(p.socket, 'camo.private.join', { code: made.code })));
await new Promise((r) => setTimeout(r, 500));
const roster = H.events.filter(([e]) => e === 'camo.players').pop()[1].players;
const eidOfName = (n) => roster.find((x) => x.name === n)?.eid;
console.log('host mutes C', JSON.stringify(await ack(H.socket, 'camo.host.act', { eid: eidOfName('Mod3'), action: 'mute' })));
console.log('non-host tries', JSON.stringify(await ack(B.socket, 'camo.host.act', { eid: eidOfName('Mod3'), action: 'kick' })));
await new Promise((r) => setTimeout(r, 300));
console.log('B saw muted:', B.events.filter(([e]) => e === 'camo.muted').length, '| C was told self:', JSON.stringify(C.events.filter(([e]) => e === 'camo.muted').map(([, d]) => d.self)));
console.log('B reports D', JSON.stringify(await ack(B.socket, 'camo.report', { eid: eidOfName('Mod4'), reason: 'voice_noise' })));
console.log('B bad reason', JSON.stringify(await ack(B.socket, 'camo.report', { eid: eidOfName('Mod4'), reason: 'nope' })));
console.log('vote in private ->', JSON.stringify(await ack(B.socket, 'camo.vote.start', { eid: eidOfName('Mod4'), kind: 'mute' })));
console.log('host kicks D (kick only)', JSON.stringify(await ack(H.socket, 'camo.host.act', { eid: eidOfName('Mod4'), action: 'kick' })));
await new Promise((r) => setTimeout(r, 500));
console.log('D told:', JSON.stringify(D.events.filter(([e]) => e === 'camo.kicked').map(([, d]) => d)));
const q = (sql) => execFileSync('psql', ['-d', DB, '-At', '-c', sql]).toString().trim();
console.log('report rows:', q(`SELECT reason||'/'||status||'/'||(context->>'phase') FROM "CamoReport" WHERE "targetUserId"='${D.id}'`));
console.log('audit:', q(`SELECT string_agg(action, ',' ORDER BY "createdAt") FROM "CamoModerationAudit" WHERE "targetUserId" IN ('${C.id}','${D.id}')`));
process.exit(0);
