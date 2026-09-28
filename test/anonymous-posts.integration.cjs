// Local-only privacy regression: disposable accounts, cleaned up in finally.
require('dotenv').config({ quiet: true });
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const jwt = require('jsonwebtoken');
const prisma = new PrismaClient();
const base = process.env.QA_API_ORIGIN || 'http://localhost:3000';
assert.ok(['localhost', '127.0.0.1'].includes(new URL(base).hostname));
assert.ok(
  ['localhost', '127.0.0.1'].includes(
    new URL(process.env.DATABASE_URL).hostname,
  ),
);
const run = randomUUID();
const tag = `anonqa${run.replaceAll('-', '')}`;
const users = [];
let asset;
const tokens = [];
async function call(who, method, path, body, expected) {
  const res = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(who == null ? {} : { Authorization: `Bearer ${tokens[who]}` }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await res.json();
  if (expected)
    assert.equal(
      res.status,
      expected,
      `${method} ${path}: ${JSON.stringify(raw)}`,
    );
  else
    assert.ok(
      res.ok,
      `${method} ${path}: ${res.status} ${JSON.stringify(raw)}`,
    );
  return raw.result;
}
function masked(value) {
  const json = JSON.stringify(value);
  for (const field of ['id', 'name', 'username', 'avatarUrl', 'email'])
    assert.ok(!json.includes(users[0][field]), `Leaked author ${field}`);
}
async function main() {
  for (let i = 0; i < 3; i++) {
    users.push(
      await prisma.user.create({
        data: {
          email: `qa-anonymous-${run}-${i}@example.test`,
          phone: `qa-${run}-${i}`,
          name: `QA private identity ${run} ${i}`,
          username: `qa${run.slice(0, 8)}${i}`,
          avatarUrl: `/qa-anonymous-${run}-${i}.png`,
          countryCode: 'EG',
          roles: i === 2 ? ['admin'] : ['player'],
          notificationPrefs: { marketing: false },
        },
      }),
    );
    tokens.push(
      jwt.sign(
        { id: users[i].id, roles: users[i].roles },
        process.env.JWT_ACCESS_SECRET,
        { expiresIn: '10m' },
      ),
    );
  }
  assert.equal(
    (await call(0, 'GET', '/posts/composer-status')).supportsAnonymous,
    true,
  );
  await call(null, 'POST', '/posts', { text: 'Hello', isAnonymous: true }, 401);
  await call(0, 'POST', '/posts', { text: 'Hello', isAnonymous: 'true' }, 400);
  await call(
    0,
    'POST',
    '/posts',
    { text: 'Hello', isAnonymous: true, linkedMatchId: randomUUID() },
    400,
  );
  await call(
    2,
    'POST',
    '/posts',
    { text: 'Hello', isAnonymous: true, authorKind: 'official' },
    400,
  );
  await call(1, 'POST', `/follows/${users[0].id}`, {});
  asset = await prisma.mediaAsset.create({
    data: {
      userId: users[0].id,
      type: 'image',
      key: `qa/${run}.webp`,
      url: `/qa/${run}.webp`,
      thumbnailUrl: `/qa/${run}.webp`,
      mimeType: 'image/webp',
      status: 'ready',
      width: 10,
      height: 10,
    },
  });
  const anon = await call(0, 'POST', '/posts', {
    text: `Hello @${users[1].username} #${tag}`,
    isAnonymous: true,
    mediaAssetIds: [asset.id],
  });
  masked(anon);
  assert.equal(anon.isOwn, true);
  assert.equal(anon.isAnonymous, true);
  assert.equal(
    (await prisma.post.findUnique({ where: { id: anon.id } })).authorId,
    users[0].id,
  );
  const named = await call(0, 'POST', '/posts', { text: `Named post #${tag}` });
  assert.equal(named.authorId, users[0].id);
  assert.equal(named.isAnonymous, false);
  for (const who of [null, 0, 1, 2]) {
    const detail = await call(who, 'GET', `/posts/${anon.permalink}`);
    masked(detail);
    assert.equal(detail.isOwn, who === 0);
    assert.equal(detail.followingAuthor, false);
  }
  for (const path of [
    `/hashtags/${tag}/posts`,
    '/posts/feed?tab=discover&limit=50',
    '/posts/explore',
  ]) {
    const data = await call(1, 'GET', path);
    const row = (data.items || data.posts).find((p) => p.id === anon.id);
    assert.ok(row, `Missing anonymous post in ${path}`);
    masked(row);
  }
  for (const who of [null, 1, 2]) {
    const profile = await call(who, 'GET', `/users/${users[0].id}/posts`);
    assert.ok(!profile.items.some((p) => p.id === anon.id));
    assert.ok(profile.items.some((p) => p.id === named.id));
  }
  const own = await call(0, 'GET', `/users/${users[0].id}/posts`);
  masked(own.items.find((p) => p.id === anon.id));
  assert.ok(
    !(await call(1, 'GET', '/posts/feed?tab=following')).items.some(
      (p) => p.id === anon.id,
    ),
  );
  const root = await call(1, 'POST', `/posts/${anon.id}/comments`, {
    text: 'Public reply',
  });
  const reply = await call(0, 'POST', `/posts/${anon.id}/comments`, {
    text: 'Author reply',
    parentCommentId: root.id,
  });
  masked(reply);
  assert.equal(reply.isAnonymous, true);
  masked(await call(null, 'GET', `/posts/${anon.id}/comments`));
  await call(1, 'PATCH', `/posts/${anon.id}`, { text: 'Not mine' }, 403);
  await call(1, 'DELETE', `/posts/${anon.id}`, undefined, 403);
  const edited = await call(0, 'PATCH', `/posts/${anon.id}`, {
    text: `Edited #${tag}`,
  });
  masked(edited);
  assert.equal(edited.isAnonymous, true);
  assert.equal(edited.isOwn, true);
  await call(1, 'GET', `/admin/moderation/posts/${anon.id}`, undefined, 403);
  assert.equal(
    (await call(2, 'GET', `/admin/moderation/posts/${anon.id}`)).author.id,
    users[0].id,
  );
  const alerts = await prisma.notification.findMany({
    where: { userId: users[1].id },
  });
  masked(alerts);
  assert.ok(alerts.length > 0);
  await call(1, 'DELETE', `/post-comments/${reply.id}`, undefined, 403);
  await call(0, 'DELETE', `/post-comments/${reply.id}`);
  await call(0, 'DELETE', `/posts/${anon.id}`);
  await call(null, 'GET', `/posts/${anon.id}`, undefined, 410);
  console.log(
    'PASS: anonymous/named creation, media, validation, discovery, profiles, following, replies, notifications, ownership and moderator boundaries',
  );
}
async function cleanup() {
  const ids = users.map((u) => u.id);
  if (!ids.length) return;
  await prisma.post.deleteMany({ where: { authorId: { in: ids } } });
  await prisma.notification.deleteMany({ where: { userId: { in: ids } } });
  await prisma.analyticsEvent.deleteMany({ where: { userId: { in: ids } } });
  await prisma.hashtag.deleteMany({ where: { tag } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
}
main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup();
    await prisma.$disconnect();
  });
