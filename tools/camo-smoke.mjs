// Real-socket smoke test of the camo game against a locally running API (default :3050): guests, queue, roles, paint.
// socket.io-client lives in the Angular repo's node_modules (the API repo only has the server half)
import { io } from '/Users/hossamelharery/Documents/Playgrounds/angular/node_modules/socket.io-client/build/esm/index.js';

const API = process.env.API || 'http://localhost:3050';
const N = Number(process.env.N || 3);
const log = (...a) => console.log(...a);

async function guest(i) {
  const r = await fetch(`${API}/api/v1/auth/guest/play`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: `Smoke${i}`, deviceId: `smoke-dev-${Date.now()}-${i}` }) });
  const j = await r.json();
  if (!j.result?.accessToken) throw new Error('guest failed: ' + JSON.stringify(j));
  return { token: j.result.accessToken, id: j.result.user.id, name: j.result.user.name };
}

const players = [];
for (let i = 1; i <= N; i++) {
  const g = await guest(i);
  const socket = io(API, { auth: { token: g.token }, transports: ['websocket'] });
  const seen = {};
  socket.onAny((e, p) => { seen[e] = (seen[e] ?? 0) + 1; if (e === 'camo.voice') { seen.voicePhases ??= {}; seen.voicePhases[p.phase] = (seen.voicePhases[p.phase] ?? 0) + 1; } if (e === 'camo.match.state') seen.lastState = p; if (e === 'camo.players') seen.lastPlayers = p; });
  await new Promise((res) => socket.on('connect', res));
  await new Promise((r) => setTimeout(r, 600));
  players.push({ ...g, socket, seen });
}
const ack = (s, ev, body) => new Promise((res) => s.emit(ev, body, res));

for (const p of players) {
  const h = await ack(p.socket, 'camo.hello', { protocolVersion: 1 });
  log(p.name, 'hello', JSON.stringify(h));
}
const bad = await ack(players[0].socket, 'camo.hello', { protocolVersion: 0 });
log('old client ->', JSON.stringify(bad));
for (const p of players) log(p.name, 'queue', JSON.stringify(await ack(p.socket, 'camo.queue.join', { roomId: 'any' })));
await new Promise((r) => setTimeout(r, 14_500));
for (const p of players) log(p.name, 'phase', p.seen.lastState?.phase, 'you', JSON.stringify(p.seen.lastState?.you), 'players', p.seen.lastPlayers?.players?.length);
await new Promise((r) => setTimeout(r, 5_000));
const hider = players.find((p) => p.seen.lastState?.you?.role === 'hider');
const seeker = players.find((p) => p.seen.lastState?.you?.role === 'seeker');
log('roles', players.map((p) => p.name + ':' + p.seen.lastState?.you?.role + '/' + p.seen.lastState?.phase).join(' '));
if (hider) {
  // one fill stroke: kind 0 fill? build bytes by hand: u16 count, then 18 bytes
  const b = new Uint8Array(2 + 18); const v = new DataView(b.buffer);
  v.setUint16(0, 1, true); v.setUint8(2, 3); // kind fill index 3
  v.setUint8(2 + 1 + 6 + 1, 0x44); v.setUint8(2 + 1 + 6 + 2, 0x66); v.setUint8(2 + 1 + 6 + 3, 0x88); v.setUint8(2 + 1 + 6 + 4, 200); v.setUint8(2 + 1 + 6 + 5, 255);
  log('paint ack', JSON.stringify(await ack(hider.socket, 'camo.paint', { bytes: b })));
  log('pose ack', JSON.stringify(await ack(hider.socket, 'camo.pose', { poseId: 'crouch' })));
  hider.socket.emit('camo.move', { x: 0, z: 4, yaw: 0, vx: 0, vz: 0, seq: 1 });
}
if (seeker) log('seeker positions events before whistle:', seeker.seen['camo.positions'] ?? 0);
await new Promise((r) => setTimeout(r, 1_500));
for (const p of players) log(p.name, 'events', Object.entries(p.seen).filter(([k]) => k.startsWith('camo.')).map(([k, n]) => k.replace('camo.', '') + '=' + n).join(' '));
for (const p of players) log(p.name, 'camo.voice', p.seen['camo.voice'], JSON.stringify(p.seen.voicePhases));
for (const p of players) p.socket.close();
process.exit(0);
