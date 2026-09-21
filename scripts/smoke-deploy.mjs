#!/usr/bin/env node
// Post-deploy smoke test. Usage:
//   BASE_URL=https://api.example.com/api/v1 SMOKE_EMAIL=owner@x SMOKE_PASSWORD=... node scripts/smoke-deploy.mjs
// Creates ONE manual booking far in the future and cancels it again. Exits non-zero on the first failure.
const BASE = process.env.BASE_URL ?? 'http://localhost:3000/api/v1';
const { SMOKE_EMAIL, SMOKE_PASSWORD } = process.env;
let failed = 0;
const un = (j) => j?.result ?? j;
async function call(method, path, token, body) {
  const r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let j; try { j = await r.json(); } catch { /* binary */ }
  return { s: r.status, j: un(j), r };
}
function check(name, ok, extra = '') { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${extra}`); if (!ok) failed++; }

// Liveness lives at the server root, outside the /api/v1 prefix.
const h = await fetch(BASE.replace(/\/api\/v1\/?$/, '') + '/'); check('health', h.status === 200);
const rd = await call('GET', '/ready', null); check('ready (db + migrations)', rd.s === 200 && rd.j?.status === 'ready', JSON.stringify(rd.j));
if (!SMOKE_EMAIL || !SMOKE_PASSWORD) { console.log('SKIP  authenticated checks (set SMOKE_EMAIL / SMOKE_PASSWORD)'); process.exit(failed ? 1 : 0); }

const login = await call('POST', '/auth/login', null, { email: SMOKE_EMAIL, password: SMOKE_PASSWORD });
const token = login.j?.accessToken ?? login.j?.tokens?.accessToken; check('login', !!token);
if (!token) process.exit(1);
const venues = await call('GET', '/owner/venues', token); const venue = (Array.isArray(venues.j) ? venues.j : venues.j?.venues ?? [])[0];
check('owner venues', !!venue); if (!venue) process.exit(1);
const court = venue.courts?.[0]; check('has a court', !!court);
const date = new Date(Date.now() + 200 * 864e5).toISOString().slice(0, 10);
const board = await call('GET', `/owner/board?venueId=${venue.id}&date=${date}`, token); check('board', board.s === 200);
check('access', (await call('GET', '/owner/access', token)).s === 200);
check('summary (profit fields)', (await call('GET', `/owner/summary?venueId=${venue.id}`, token)).j?.totals?.netProfit !== undefined);
check('team list', [200, 403].includes((await call('GET', `/team?venueId=${venue.id}`, token)).s));
check('subscription', [200, 403].includes((await call('GET', `/owner/subscription?venueId=${venue.id}`, token)).s));
check('fixed bookings list', (await call('GET', `/owner/fixed-bookings?venueId=${venue.id}`, token)).s === 200);
check('expenses list', (await call('GET', `/owner/expenses?venueId=${venue.id}`, token)).s === 200);
const ex = await fetch(`${BASE}/owner/exports?venueId=${venue.id}&from=${date.slice(0, 8)}01&to=${date}&format=xlsx&lang=en`, { headers: { authorization: `Bearer ${token}` } });
check('export xlsx', ex.status === 200 && (await ex.arrayBuffer()).byteLength > 1000);
if (court) {
  const startsAt = `${date}T10:00:00.000Z`;
  const b = await call('POST', '/owner/bookings/manual', token, { venueId: venue.id, courtId: court.id, startsAt, durationMinutes: 60, priceAmount: 100, paymentStatus: 'unpaid', customerName: 'SMOKE TEST' });
  check('manual booking create', b.s === 201 && !!b.j?.id, String(b.s));
  if (b.j?.id) check('manual booking cancel', [200, 201].includes((await call('DELETE', `/owner/bookings/${b.j.id}`, token)).s));
}
console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll smoke checks passed');
process.exit(failed ? 1 : 0);
