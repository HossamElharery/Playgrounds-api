// End-to-end check of owner/staff calls against a LOCAL API with the demo data (owner@, reception@,
// player0@ matchena.com / Password123!) and STAFF_CALLS_ENABLED=true. Real sockets, real REST.
//
//   API=http://localhost:3000 node scripts/test-staff-calls.mjs
//
// socket.io-client comes from the Angular app's node_modules (the API does not depend on it).
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(join(dirname(fileURLToPath(import.meta.url)), '../../../angular/package.json'));
const { io } = require('socket.io-client');

const API = process.env.API ?? 'http://localhost:3000';
const B = `${API}/api/v1`;
let failed = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login(email) {
  const res = await fetch(`${B}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'Password123!' }) });
  const body = await res.json();
  const token = body.result?.accessToken ?? body.accessToken;
  if (!token) throw new Error(`login ${email}: ${JSON.stringify(body).slice(0, 120)}`);
  return token;
}
const api = (token) => async (method, path, data) => {
  const res = await fetch(`${B}${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: data ? JSON.stringify(data) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json?.result ?? json, raw: json };
};
function socket(token) {
  const s = io(API, { auth: { token }, transports: ['websocket'] });
  const got = [];
  for (const ev of ['call.incoming', 'call.ringing', 'call.accepted', 'call.ended', 'call.offer', 'call.answer', 'call.ice']) s.on(ev, (p) => got.push(p));
  return { s, got, wait: async (type, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { const hit = got.find((e) => e.type === type); if (hit) return hit; await sleep(30); } return null; } };
}

const ownerTok = await login('owner@matchena.com');
const recTok = await login('reception@matchena.com');
const playerTok = await login('player0@matchena.com');
const owner = api(ownerTok), rec = api(recTok), player = api(playerTok);
const O = socket(ownerTok), R = socket(recTok);
await sleep(600);

// directory
let r = await owner('GET', '/calls/directory');
ok(r.status === 200 && r.body.enabled === true && r.body.members.length === 4, `owner sees 4 teammates (got ${r.body?.members?.length})`);
const reception = r.body.members.find((m) => m.title === 'Reception');
ok(!!reception && reception.online === true, 'reception shows online');
r = await rec('GET', '/calls/directory');
const ownerEntry = r.body.members.find((m) => m.role === 'owner');
ok(r.body.members.length === 4 && !!ownerEntry, 'staff sees owner + 3 colleagues (not self)');
ok(!('permissions' in (r.body.members[0] ?? {})) && !('email' in (r.body.members[0] ?? {})), 'directory leaks no email/permissions');

// players and strangers
r = await player('GET', '/calls/directory');
ok(r.status === 403, `player refused (${r.status})`);
r = await player('POST', '/calls', { calleeId: ownerEntry.id });
ok(r.status === 403, `player cannot call (${r.status})`);

// call, ring, ack, accept, relay, end
r = await owner('POST', '/calls', { calleeId: reception.id });
ok(r.status === 201 && r.body.call.status === 'ringing', `owner -> reception rings (${r.status})`);
const callId = r.body.call.id;
ok(Array.isArray(r.body.iceServers?.iceServers), 'ICE servers returned');
const incoming = await R.wait('call.incoming');
ok(incoming?.callId === callId && incoming.from.role === 'owner', 'reception receives call.incoming');
R.s.emit('call.ringing', { callId, native: true });
ok(!!(await O.wait('call.ringing')), 'owner sees "ringing" after the ack');
r = await owner('POST', '/calls', { calleeId: reception.id });
ok(r.status === 409, `second call from the same caller refused (${r.status})`);
r = await rec('GET', '/calls/active');
ok(r.body.incoming?.id === callId, 'active shows the incoming call after a reload');
O.s.emit('call.offer', { callId, sdp: { type: 'offer', sdp: 'v=0' } });
await sleep(300);
ok(!R.got.find((e) => e.type === 'call.offer'), 'no signaling relayed before the call is answered');
r = await owner('POST', `/calls/${callId}/accept`);
ok(r.status === 404, `caller cannot accept own call (${r.status})`);
r = await rec('POST', `/calls/${callId}/accept`);
ok(r.status === 200 && r.body.call.status === 'answered', `reception accepts (${r.status})`);
ok(!!(await O.wait('call.accepted')), 'owner receives call.accepted');
O.s.emit('call.offer', { callId, sdp: { type: 'offer', sdp: 'v=0 owner' } });
const off = await R.wait('call.offer');
ok(off?.fromUserId && off.sdp?.sdp === 'v=0 owner', 'offer relayed to reception, sender stamped by server');
R.s.emit('call.answer', { callId, sdp: { type: 'answer', sdp: 'v=0 rec' } });
ok(!!(await O.wait('call.answer')), 'answer relayed to owner');
const P = socket(playerTok); await sleep(400);
P.s.emit('call.offer', { callId, sdp: { type: 'offer', sdp: 'evil' } });
await sleep(400);
ok(!R.got.some((e) => e.sdp?.sdp === 'evil') && !O.got.some((e) => e.sdp?.sdp === 'evil'), 'an outsider socket cannot inject signaling');
r = await owner('POST', `/calls/${callId}/end`);
ok(r.status === 200, 'owner hangs up');
ok(!!(await R.wait('call.ended')), 'reception receives call.ended');
O.got.length = 0; R.got.length = 0;
R.s.emit('call.ice', { callId, candidate: { candidate: 'x' } });
await sleep(300);
ok(!O.got.some((e) => e.type === 'call.ice'), 'no relay after the call ended');

// mute: caller told only "unavailable"
r = await rec('PUT', `/calls/mutes/${ownerEntry.id}`, { minutes: 60 });
ok(r.status === 200 && !!r.body.mutedUntil, 'reception mutes the owner for 60 min');
r = await rec('PUT', `/calls/mutes/${ownerEntry.id}`, { minutes: 9999 });
ok(r.status === 400, `mute above 8h rejected (${r.status})`);
R.got.length = 0;
r = await owner('POST', '/calls', { calleeId: reception.id });
ok(r.body.call.status === 'unavailable', `muted call -> unavailable (${r.body.call.status})`);
await sleep(500);
ok(!R.got.some((e) => e.type === 'call.incoming'), 'muted reception is not rung');
r = await owner('GET', '/calls/directory');
ok(r.body.members.find((m) => m.id === reception.id).mutedUntil === null, 'owner is not told about the mute');
await rec('DELETE', `/calls/mutes/${ownerEntry.id}`);

// decline + missed + history
r = await owner('POST', '/calls', { calleeId: reception.id });
await rec('POST', `/calls/${r.body.call.id}/decline`);
ok(!!(await O.wait('call.ended')) && O.got.find((e) => e.type === 'call.ended').status === 'declined', 'decline reaches the caller');
O.got.length = 0;
r = await owner('POST', '/calls', { calleeId: reception.id });
await owner('POST', `/calls/${r.body.call.id}/cancel`);
r = await rec('GET', '/calls/recent');
ok(r.body.items[0].status === 'cancelled' && r.body.items[0].unseen === true && r.body.missedUnseen >= 1, 'cancelled-while-ringing shows as an unseen missed call');
await rec('POST', '/calls/recent/seen');
r = await rec('GET', '/calls/recent');
ok(r.body.missedUnseen === 0, 'opening recent clears the badge');

// DND
r = await rec('PUT', '/calls/dnd', { minutes: 30 });
ok(r.status === 200 && !!r.body.dndUntil, 'do-not-disturb on');
r = await owner('POST', '/calls', { calleeId: reception.id });
ok(r.body.call.status === 'unavailable', 'DND -> unavailable');
await rec('PUT', '/calls/dnd', { minutes: 0 });

for (const x of [O, R, P]) x.s.close();
console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
process.exit(failed ? 1 : 0);
