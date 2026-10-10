const {readFileSync} = require('node:fs');
const {spawnSync,spawn} = require('node:child_process');
const {PrismaClient} = require('@prisma/client');
const bcrypt = require('bcrypt');
const dotenv = require('dotenv');
const DATABASE = process.env.SOCIAL_QA_DATABASE ?? 'matchena_social_preview_20261008';
let stage = 'configuration';

async function main() {
  if (!/^matchena_social_preview_[a-z0-9_]{1,30}$/.test(DATABASE)) throw new Error('Dedicated social QA database name required');
  const port = Number(process.env.SOCIAL_QA_API_PORT ?? 3102);
  if (!Number.isInteger(port) || port < 3102 || port > 3199) throw new Error('Reserved social QA API port required');
  const userCount = Number(process.env.SOCIAL_QA_USER_COUNT ?? 7);
  if (!Number.isInteger(userCount) || userCount < 2 || userCount > 7) throw new Error('Two to seven synthetic QA members required');
  const site = new URL(process.env.SOCIAL_QA_SITE ?? 'http://127.0.0.1:4204');
  if (!['localhost','127.0.0.1'].includes(site.hostname) || site.protocol !== 'http:' || !site.port || [3000,4200].includes(Number(site.port))) throw new Error('Isolated loopback QA frontend required');
  const local = dotenv.parse(readFileSync('.env','utf8'));
  const url = new URL(process.env.SOCIAL_TEST_DATABASE_URL ?? local.DATABASE_URL);
  if (!['localhost','127.0.0.1','[::1]'].includes(url.hostname)) throw new Error('Local PostgreSQL required');
  url.pathname='/postgres';
  stage = 'isolated database';
  const admin = new PrismaClient({datasources:{db:{url:url.toString()}}});
  const databases = await admin.$queryRaw`SELECT datname FROM pg_database WHERE datname=${DATABASE}`;
  if (!databases.length) await admin.$executeRawUnsafe(`CREATE DATABASE "${DATABASE}"`);
  await admin.$disconnect();
  url.pathname=`/${DATABASE}`;
  const env = {...process.env,...local};
  for (const key of Object.keys(env)) if (/^(AWS_|SMTP_|TWILIO_|GOOGLE_|FACEBOOK_|OPENAI_|OPENROUTER_|FCM_|FIREBASE_|VAPID_|TURN_)/.test(key)) env[key]='';
  Object.assign(env, {DATABASE_URL:url.toString(),NODE_ENV:'test',PORT:String(port),
    JWT_ACCESS_SECRET:'social-preview-only-access-secret-20261008',JWT_REFRESH_SECRET:'social-preview-only-refresh-secret-20261008',
    QR_SIGNING_SECRET:'social-preview-only-qr-signing-secret-20261008',STORAGE_PROVIDER:'local',OTP_PROVIDER:'console',SMTP_PORT:'587',
    CORS_ORIGINS:`http://127.0.0.1:4203,http://localhost:4203,http://127.0.0.1:4204,http://localhost:4204,${site.origin}`,SITE_URL:site.origin,
    LOBBY_SOCIAL_ENABLED:'true',LOBBY_SOCIAL_ALLOW_DRAFT_CONTENT:'true',LOBBY_MOVEMENT_ENABLED:'true',
    LOBBY_BALL_ENABLED:'true',LOBBY_KIOSK_ENABLED:'true',LOBBY_MORPHS_ENABLED:'false'});
  stage = 'isolated schema';
  const push=spawnSync('npx',['prisma','db','push','--skip-generate'],{env,encoding:'utf8'});
  if(push.status!==0) {
    console.error((push.stderr??'').replace(/postgres(?:ql)?:\/\/\S+/g,'<local database>'));
    throw new Error('Isolated schema creation failed');
  }
  stage = 'synthetic users';
  const db = new PrismaClient({datasources:{db:{url:url.toString()}}});
  if (process.argv.includes('--cleanup-admin-evidence')) {
    await db.$executeRaw`DELETE FROM "LobbySocialQuestion" WHERE "data"->>'familyId'='qa-admin-evidence'`;
  }
  if (process.argv.includes('--reset-preview')) {
    await db.$executeRaw`DELETE FROM "LobbySocialState" WHERE "squadId"='social-room'`;
    await db.$executeRaw`DELETE FROM "LobbySocialExposure" WHERE "userId" LIKE 'social-%'`;
    await db.squadMember.deleteMany({where:{squadId:'social-room',userId:{startsWith:'social-'}}});
  }
  const passwordHash = await bcrypt.hash('MatchenaSocialLocal123!',10);
  await db.countryConfig.upsert({where:{code:'EG'},create:{code:'EG',nameEn:'Egypt',nameAr:'مصر',currency:'EGP',phoneCallingCode:'+20',paymentMethods:[]},update:{}});
  const names=['يوسف','مريم','أحمد','سارة','آدم','Nour Hassan اسم طويل للاختبار','عبد الرحمن محمد اسم طويل جدًا'];
  await db.squad.upsert({where:{id:'social-room'},create:{id:'social-room'},update:{}});
  for (let i=0;i<userCount;i++) {
    const letter=String.fromCharCode(97+i),id=`social-${letter}`;
    await db.user.upsert({where:{id},create:{id,name:names[i],email:`social-${letter}@example.test`,emailVerifiedAt:new Date(),passwordHash,roles:['player'],status:'active',lastSeenAt:new Date()},update:{passwordHash,status:'active',lastSeenAt:new Date()}});
    await db.squadMember.upsert({where:{squadId_userId:{squadId:'social-room',userId:id}},create:{id:`social-member-${letter}`,squadId:'social-room',userId:id,isLeader:i===0,micMuted:false},update:{isLeader:i===0,micMuted:false}});
  }
  if (process.argv.includes('--include-admin')) {
    await db.user.upsert({where:{id:'social-admin'},create:{id:'social-admin',name:'Social QA Admin',email:'social-admin@example.test',emailVerifiedAt:new Date(),passwordHash,roles:['admin'],status:'active'},update:{passwordHash,roles:['admin'],status:'active'}});
  }
  await db.$disconnect();
  console.log(`Isolated social QA database ready; API http://127.0.0.1:${port}. ${userCount} synthetic members, social-a@example.test through social-${String.fromCharCode(96+userCount)}@example.test.`);
  if (process.argv.includes('--seed-only')) return;
  const child=spawn(process.execPath,['scripts/social-preview-main.cjs'],{env,stdio:'inherit'});
  for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>child.kill(signal));
  child.on('exit',code=>process.exit(code??0));
}
main().catch(e=>{console.error(`Local social QA environment could not start at ${stage} (${e.code??e.constructor.name}). No application database changed.`);process.exit(1);});
