// Local-only integration exercise. Creates isolated QA accounts; no real users are changed.
require('dotenv').config({ quiet: true });
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const prisma = new PrismaClient();
const base = process.env.QA_API_ORIGIN || 'http://localhost:3000';
const runId = process.argv[3] || randomUUID();
assert.match(runId, /^[a-f0-9-]{36}$/);
assert.ok(['localhost', '127.0.0.1'].includes(new URL(base).hostname));
assert.ok(['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL).hostname));
const emails = [0, 1, 2].map(i => `qa-social-${runId}-${i}@example.test`);
let ids = [], threads = [], teamIds = [];
async function cleanup() {
  const users = await prisma.user.findMany({ where: { email: { in: emails } }, select: { id: true } });
  const userIds = users.map(u => u.id);
  if (!userIds.length) return;
  const teams = await prisma.team.findMany({ where: { captainId: { in: userIds } }, select: { id: true, chatThreadId: true } });
  const ownedTeamIds = [...new Set([...teamIds, ...teams.map(t => t.id)])];
  const participated = await prisma.chatThread.findMany({ where: { participants: { some: { userId: { in: userIds } }, every: { userId: { in: userIds } } } }, select: { id: true } });
  const threadIds = [...new Set([...threads, ...teams.map(t => t.chatThreadId).filter(Boolean), ...participated.map(t => t.id)])];
  await prisma.teamChallenge.deleteMany({ where: { OR: [{ challengerTeamId: { in: ownedTeamIds } }, { challengedTeamId: { in: ownedTeamIds } }] } });
  await prisma.team.deleteMany({ where: { id: { in: ownedTeamIds } } });
  await prisma.chatMessage.deleteMany({ where: { threadId: { in: threadIds } } });
  await prisma.chatThreadParticipant.deleteMany({ where: { threadId: { in: threadIds } } });
  await prisma.chatThread.deleteMany({ where: { id: { in: threadIds } } });
  await prisma.matchPost.deleteMany({ where: { authorId: { in: userIds } } });
  await prisma.friendship.deleteMany({ where: { OR: [{ requesterId: { in: userIds } }, { addresseeId: { in: userIds } }] } });
  await prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}
async function main() {
  if (process.argv[2] === '--cleanup') { await cleanup(); console.log('QA fixture cleaned'); return; }
  const password = `QA-${runId}!`;
  const hash = await bcrypt.hash(password, 10);
  for (let i = 0; i < 3; i++) {
    const user = await prisma.user.create({ data: { email: emails[i], phone: `qa-${runId}-${i}`, name: ['QA Captain', 'QA Player', 'QA Outsider'][i], passwordHash: hash, countryCode: 'EG', notificationPrefs: { marketing: false } } });
    ids.push(user.id);
  }
  const tokens = ids.map(id => jwt.sign({ id, roles: ['player'] }, process.env.JWT_ACCESS_SECRET, { expiresIn: '30m' }));
  async function call(who, method, path, body, expected) {
    const res = await fetch(`${base}/api/v1${path}`, { method, headers: { 'Content-Type': 'application/json', ...(who === null ? {} : { Authorization: `Bearer ${tokens[who]}` }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const raw = await res.json().catch(() => ({}));
    if (expected) assert.equal(res.status, expected, `${method} ${path}: ${JSON.stringify(raw)}`);
    else assert.ok(res.ok, `${method} ${path}: ${res.status} ${JSON.stringify(raw)}`);
    return raw.result;
  }
  for (const path of ['/friends', '/friend-requests', '/team-membership-requests', '/chat/threads', '/pulse', '/users/me']) await call(null, 'GET', path, undefined, 401);
  console.log('PASS anonymous access boundaries');
  const request = await call(0, 'POST', '/friends/requests', { addresseeId: ids[1] });
  assert.equal(request.status, 'pending');
  assert.equal((await call(0, 'GET', '/friends')).length, 0);
  assert.equal((await call(1, 'GET', '/friends')).length, 0);
  assert.equal((await call(0, 'GET', '/friend-requests?direction=all'))[0].id, request.id);
  await call(0, 'POST', `/friend-requests/${request.id}/accept`, {}, 403);
  await call(2, 'POST', `/friend-requests/${request.id}/accept`, {}, 403);
  await call(1, 'POST', `/friend-requests/${request.id}/accept`, {});
  assert.equal((await call(0, 'GET', '/friends'))[0].id, ids[1]);
  await call(0, 'POST', `/friend-requests/${request.id}/cancel`, {}, 400);
  const direct = await call(0, 'POST', '/chat/direct-threads', { participantId: ids[1] }); threads.push(direct.id);
  await call(0, 'DELETE', `/friends/${ids[1]}`);
  await call(1, 'PATCH', '/users/me/privacy', { messagePolicy: 'friends' });
  const message = () => ({ clientMessageId: randomUUID(), type: 'text', text: 'QA privacy verification' });
  await call(0, 'POST', `/chat/threads/${direct.id}/messages`, message(), 403);
  await call(1, 'PATCH', '/users/me/privacy', { messagePolicy: 'everyone' });
  await call(1, 'POST', `/users/${ids[0]}/block`, {});
  await call(0, 'POST', `/chat/threads/${direct.id}/messages`, message(), 403);
  await call(0, 'POST', '/friends/requests', { addresseeId: ids[1] }, 403);
  await call(1, 'DELETE', `/users/${ids[0]}/block`);
  console.log('PASS pending, recipient-only acceptance, unfriend, block and existing-chat privacy');
  const races = await Promise.all([0, 1].map(who => fetch(`${base}/api/v1/friends/requests`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[who]}` }, body: JSON.stringify({ addresseeId: ids[1 - who] }) })));
  assert.equal(races.filter(r => r.ok).length, 1);
  assert.equal(await prisma.friendship.count({ where: { OR: [{ requesterId: ids[0], addresseeId: ids[1] }, { requesterId: ids[1], addresseeId: ids[0] }] } }), 1);
  const pending = (await call(0, 'GET', '/friend-requests?direction=all'))[0];
  const sender = pending.requesterId === ids[0] ? 0 : 1;
  await call(sender, 'POST', `/friend-requests/${pending.id}/cancel`, {});
  await call(1 - sender, 'POST', `/friend-requests/${pending.id}/accept`, {}, 404);
  console.log('PASS simultaneous reciprocal requests and stale acceptance');
  const sports = await prisma.sportCategory.findMany({ take: 1 });
  const match = await call(0, 'POST', '/matches', { sportId: sports[0].id, dateTime: new Date(Date.now() + 3600000).toISOString(), playersNeeded: 2, skillTier: 'silver', costPerPlayerAmount: 0, notes: 'QA match lifecycle' }); threads.push(match.chatThreadId);
  const pendingMatch = await call(1, 'POST', `/matches/${match.id}/join`, {});
  assert.equal(pendingMatch.viewerJoinStatus, 'pending');
  assert.equal(pendingMatch.joined.some(player => player.userId === ids[1]), false);
  await call(1, 'POST', `/matches/${match.id}/join`, {}, 400);
  assert.equal((await call(1, 'GET', '/matches/join-statuses/mine')).find(item => item.matchPostId === match.id).status, 'pending');
  await call(2, 'GET', `/matches/${match.id}/join-requests`, undefined, 403);
  const matchRequest = (await call(0, 'GET', `/matches/${match.id}/join-requests`))[0];
  await call(2, 'POST', `/matches/join-requests/${matchRequest.id}/approve`, {}, 403);
  await call(0, 'POST', `/matches/join-requests/${matchRequest.id}/approve`, {});
  await call(0, 'POST', `/matches/join-requests/${matchRequest.id}/approve`, {}, 400);
  assert.equal((await call(1, 'GET', '/matches/join-statuses/mine')).find(item => item.matchPostId === match.id).status, 'approved');
  await call(1, 'POST', `/matches/${match.id}/leave`, {});
  const playedBefore = (await prisma.user.findUnique({ where: { id: ids[0] } })).matchesPlayed;
  await call(0, 'POST', `/matches/${match.id}/played`, {});
  await call(0, 'POST', `/matches/${match.id}/played`, {});
  assert.equal((await prisma.user.findUnique({ where: { id: ids[0] } })).matchesPlayed, playedBefore + 1);
  console.log('PASS match pending, organizer approval, leave and idempotent completion');
  const team = await call(0, 'POST', '/teams', { name: 'QA Launch Team', sportId: sports[0].id }); teamIds.push(team.id); threads.push(team.chatThreadId);
  const invite = await call(0, 'POST', `/teams/${team.id}/members/${ids[1]}`, {});
  assert.equal((await call(0, 'GET', `/teams/${team.id}`)).members.length, 1);
  await call(0, 'POST', `/team-membership-requests/${invite.id}/accept`, {}, 403);
  await call(1, 'POST', `/team-membership-requests/${invite.id}/accept`, {});
  assert.equal((await call(1, 'GET', `/teams/${team.id}`)).members.length, 2);
  await call(0, 'POST', `/teams/${team.id}/leave`, {}, 400);
  await call(2, 'DELETE', `/teams/${team.id}/members/${ids[1]}`, undefined, 403);
  await call(1, 'POST', '/chat/team-threads', { teamId: team.id });
  await call(1, 'POST', `/teams/${team.id}/leave`, {});
  await call(1, 'GET', `/chat/threads/${team.chatThreadId}/messages`, undefined, 403);
  await call(1, 'POST', `/chat/threads/${team.chatThreadId}/messages`, message(), 403);
  const join = await call(1, 'POST', `/teams/${team.id}/join-requests`, {});
  await call(1, 'POST', `/team-membership-requests/${join.id}/accept`, {}, 403);
  await call(0, 'POST', `/team-membership-requests/${join.id}/accept`, {});
  await call(0, 'POST', `/teams/${team.id}/captain/${ids[1]}`, {});
  await call(0, 'POST', `/teams/${team.id}/archive`, {}, 403);
  await call(0, 'POST', `/teams/${team.id}/leave`, {});
  await call(1, 'POST', `/teams/${team.id}/archive`, {});
  await call(1, 'GET', `/teams/${team.id}`, undefined, 404);
  assert.equal((await prisma.team.findUnique({ where: { id: team.id } })).archivedAt !== null, true);
  console.log('PASS team invitation, consent, join request, leave, transfer, authorization, archive and revoked chat access');
  if (process.argv[2] === '--fixture') {
    const uiTeam = await call(0, 'POST', '/teams', { name: 'QA Browser Team', sportId: sports[0].id });
    teamIds.push(uiTeam.id); threads.push(uiTeam.chatThreadId);
    await call(0, 'POST', '/friends/requests', { addresseeId: ids[1] });
    console.log(JSON.stringify({ runId, email: emails[0], secondEmail: emails[1], password, captainId: ids[0], memberId: ids[1], teamId: uiTeam.id }));
  }
}
main().then(async () => { if (process.argv[2] !== '--fixture') await cleanup(); }).catch(async err => { console.error(err.message); await cleanup(); process.exitCode = 1; }).finally(() => prisma.$disconnect());
