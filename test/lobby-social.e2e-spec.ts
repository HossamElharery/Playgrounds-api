import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../src/modules/prisma/prisma.service';
import { LobbySocialService } from '../src/modules/lobby-social/lobby-social.service';
import { SocialCommand, SocialSnapshot } from '../src/modules/lobby-social/social.types';
import { PresenceService } from '../src/modules/presence/presence.service';
import { SocialContentService } from '../src/modules/lobby-social/social-content.controller';
import { EGYPTIAN_SOCIAL_BANK } from '../src/modules/lobby-social/social.egyptian-bank';

/** Isolated disposable local PostgreSQL database. Never uses production or the user's app database. */
describe('Lobby social persistence and concurrent clients', () => {
  let admin: PrismaClient;
  let db: PrismaClient;
  let service: LobbySocialService;
  let created = false;
  const database = `matchena_social_test_${Date.now()}`;
  const config = new ConfigService({ LOBBY_SOCIAL_ENABLED: 'true', LOBBY_SOCIAL_ALLOW_DRAFT_CONTENT: 'true', NODE_ENV: 'test' });
  let seq = 0;
  async function command(id: string, action: string, extra: Partial<SocialCommand> = {}, snapshot?: SocialSnapshot) {
    const state = snapshot ?? await service.snapshot('room', id);
    return service.command(id, { squadId:'room', sessionId:state.session?.id, expectedVersion:state.session?.revision,
      requestId:`test-${++seq}`, action, ...extra });
  }
  async function setup(game: 'cards'|'truth'='cards') {
    await db.$executeRaw`DELETE FROM "LobbySocialState"`;
    await command('a','create',{game}); await command('b','join',{role:'player'});
    await command('c','join',{role:'player'}); await command('d','join',{role:'listener'});
    return command('a','start');
  }
  async function moveTime(fields: Record<string,unknown>) {
    const rows = await db.$queryRaw<{state:Record<string,unknown>}[]>`SELECT state FROM "LobbySocialState" WHERE "squadId"='room'`;
    const state = {...rows[0].state,...fields};
    await db.$executeRaw`UPDATE "LobbySocialState" SET state=${JSON.stringify(state)}::jsonb WHERE "squadId"='room'`;
  }
  beforeAll(async()=> {
    const dotenv = require('dotenv') as {parse:(text:string)=>Record<string,string>};
    const raw = process.env.SOCIAL_TEST_DATABASE_URL ?? dotenv.parse(readFileSync(resolve('.env'),'utf8')).DATABASE_URL;
    const url = new URL(raw);
    if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname)) throw new Error('Social integration tests require local PostgreSQL');
    url.pathname='/postgres'; admin=new PrismaClient({datasources:{db:{url:url.toString()}}});
    await admin.$executeRawUnsafe(`CREATE DATABASE "${database}"`); created=true;
    url.pathname=`/${database}`;db=new PrismaClient({datasources:{db:{url:url.toString()}}});
    await db.$executeRawUnsafe('CREATE TABLE "User" (id TEXT PRIMARY KEY)');
    await db.$executeRawUnsafe('CREATE TABLE "Squad" (id TEXT PRIMARY KEY)');
    await db.$executeRawUnsafe('CREATE TABLE "SquadMember" (id TEXT PRIMARY KEY, "squadId" TEXT NOT NULL, "userId" TEXT NOT NULL, UNIQUE("squadId","userId"))');
    for(const sql of readFileSync(resolve('prisma/migrations/20261008110000_lobby_social_games/migration.sql'),'utf8').split(';').filter(s=>s.trim())) await db.$executeRawUnsafe(sql);
    await db.$executeRawUnsafe(readFileSync(resolve('prisma/migrations/20261008170000_social_question_content/migration.sql'),'utf8'));
    await db.$executeRaw`INSERT INTO "Squad" VALUES ('room'),('other')`;
    for(const id of ['a','b','c','d','e','outsider']) {
      await db.$executeRaw`INSERT INTO "User" VALUES (${id})`;
      await db.$executeRaw`INSERT INTO "SquadMember" VALUES (${id},${id==='outsider'?'other':'room'},${id})`;
    }
    service=new LobbySocialService(db as PrismaService,config);
  },30_000);
  afterAll(async()=> { await db?.$disconnect();if(created)await admin.$executeRawUnsafe(`DROP DATABASE "${database}"`);await admin?.$disconnect(); });

  it('persists admin overrides and new questions across content service restarts',async()=>{
    const content=new SocialContentService(db as PrismaService),seed=EGYPTIAN_SOCIAL_BANK[0];
    const saved=await content.save(seed.id,{...seed,text:'إيه أطرف موقف حصل في خروجة قريبة؟'},'admin-test');
    expect(saved.version).toBe(2);expect(saved.reviewedAt).toBeNull();
    await content.save('custom-test',{...seed,version:0,familyId:'custom-test',status:'published'},'admin-test');
    const restored=await new SocialContentService(db as PrismaService).list();
    expect(restored.find(q=>q.id===seed.id)?.text).toBe(saved.text);
    expect(restored.find(q=>q.id==='custom-test')?.reviewedAt).not.toBeNull();
    expect(restored).toHaveLength(61);
  });
  it('serializes conflicting editors without losing an accepted edit',async()=>{
    const content=new SocialContentService(db as PrismaService),seed=EGYPTIAN_SOCIAL_BANK[1];
    const edits=await Promise.allSettled([
      content.save(seed.id,{...seed,text:'إيه أكلة بتخلص قبل ما القعدة تبدأ؟'},'editor-a'),
      content.save(seed.id,{...seed,text:'إيه أكلة بتستناها في خروجة الصحاب؟'},'editor-b'),
    ]);
    expect(edits.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    expect(edits.filter(r=>r.status==='rejected')).toHaveLength(1);
    expect((await content.list()).find(q=>q.id===seed.id)?.version).toBe(2);
  });
  it('uses persistent content for future draws but retains the revealed round text',async()=>{
    await db.$executeRaw`DELETE FROM "LobbySocialState"`;
    const content=new SocialContentService(db as PrismaService);
    const live=new LobbySocialService(db as PrismaService,config,undefined,content);
    const create=await live.command('a',{squadId:'room',requestId:'content-create',action:'create',game:'cards'});
    const joined=await live.command('b',{squadId:'room',sessionId:create.session!.id,expectedVersion:create.session!.revision,requestId:'content-join',action:'join',role:'player'});
    const started=await live.command('a',{squadId:'room',sessionId:joined.session!.id,expectedVersion:joined.session!.revision,requestId:'content-start',action:'start'});

    await moveTime({phaseAt:Date.now()-1500,revealAt:Date.now()-1000});
    const revealed=await live.snapshot('room','a');const question=revealed.session!.question!;
    const original=(await content.list()).find(q=>q.id===question.id)!;
    await content.save(original.id,{...original,text:'ده سؤال جديد للجولات القادمة فقط، إيه رأيك؟'},'editor');
    expect((await live.snapshot('room','b')).session!.question?.text).toBe(question.text);
    await db.$executeRaw`DELETE FROM "LobbySocialState"`;
    await db.$executeRaw`DELETE FROM "LobbySocialExposure"`;
  });

  it('serializes concurrent creation into one active session',async()=> {
    const results=await Promise.all([command('a','create',{game:'cards'}),command('b','create',{game:'truth'})]);
    expect(results[0].session!.id).toBe(results[1].session!.id);
    expect(await db.$queryRaw`SELECT "squadId" FROM "LobbySocialState"`).toHaveLength(1);
  });
  it('rejects a cross-room actor even if the transport guard is bypassed',async()=> {
    await expect(command('outsider','create',{game:'cards'})).rejects.toThrow('not_in_room');
  });
  it('applies a retried answer once, and rejects competing versions',async()=> {
    await setup();await moveTime({revealAt:Date.now()-1});const current=await service.snapshot('room','a');
    const cmd:SocialCommand={squadId:'room',sessionId:current.session!.id,expectedVersion:current.session!.revision,requestId:'same-answer',action:'finish'};
    const result=await service.command('a',cmd);
    expect((await service.command('a',cmd)).session!.roundId).toBe(result.session!.roundId);
    await expect(service.command('a',{...cmd,requestId:'another-answer'})).rejects.toThrow('stale');
  });
  it('stores exposure exactly once on reveal and late-viewer snapshots',async()=> {
    await setup();
    await db.$executeRaw`DELETE FROM "LobbySocialExposure"`;
    expect(await db.$queryRaw`SELECT * FROM "LobbySocialExposure"`).toHaveLength(0);
    await moveTime({revealAt:Date.now()-1});
    const state=await service.snapshot('room','a'); expect(state.session!.question).not.toBeNull();
    await service.snapshot('room','a'); await service.snapshot('room','d');
    expect(await db.$queryRaw`SELECT * FROM "LobbySocialExposure"`).toHaveLength(4);
    await command('e','join',{role:'listener'});
    await service.snapshot('room','e'); expect(await db.$queryRaw`SELECT * FROM "LobbySocialExposure"`).toHaveLength(5);
  });
  it('restores private choice and editable vote after constructing a new server service',async()=> {
    await setup('truth');await command('a','commit',{choice:'fabrication'});
    await command('a','finishStory');await command('a','openVoting');await command('b','vote',{choice:'truth'});
    service=new LobbySocialService(db as PrismaService,config);
    expect((await service.snapshot('room','a')).personal.choice).toBe('fabrication');
    expect((await service.snapshot('room','b')).personal.vote).toBe('truth');
    expect(JSON.stringify(await service.snapshot('room','c'))).not.toContain('fabrication');
    await command('b','vote',{choice:'fabrication'});
    expect((await service.snapshot('room','b')).personal.vote).toBe('fabrication');
  });
  it('resolves an expired persisted deadline after restart once and publishes no early outcome',async()=> {
    await moveTime({voteDeadline:Date.now()-1});
    const before=await service.snapshot('room','c'); expect(before.session!.phase).toBe('reveal');expect(before.session!.outcome).toBeNull();
    await moveTime({revealAt:Date.now()-1});
    const after=await service.snapshot('room','c'); expect(after.session!.phase).toBe('discussion');expect(after.session!.outcome!.correct).toBe(1);
    await expect(command('b','vote',{choice:'truth'})).rejects.toThrow('vote_closed');
    expect((await service.snapshot('room','c')).session!.outcome).toEqual(after.session!.outcome);
  });
  it('projects room and individual events without leaking secrets to host or another participant',async()=> {
    await setup('truth'); const events:Map<string,SocialSnapshot>[]=[];
    service.publish=(_,s)=>events.push(s);
    await command('a','commit',{choice:'fabrication'});
    const event=events.at(-1)!;
    expect(JSON.stringify(event.get(''))).not.toContain('fabrication');expect(JSON.stringify(event.get('b'))).not.toContain('fabrication');
    expect(event.get('a')!.personal.choice).toBe('fabrication');service.publish=null;
  });
  it('records actual viewers while excluding a minimized target, and accepts an outside-game viewer once',async()=> {
    await setup();await command('b','pulse',{viewing:false});
    await moveTime({revealAt:Date.now()-1});const state=await service.snapshot('room','a');
    const rows=await db.$queryRaw<{userId:string}[]>`SELECT "userId" FROM "LobbySocialExposure" WHERE "roundId"=${state.session!.roundId}`;
    expect(rows.map(r=>r.userId)).not.toContain('b');
    const extra={roundId:state.session!.roundId!,questionId:state.session!.question!.id};
    await command('e','seen',extra);await command('e','seen',extra);
    expect(await db.$queryRaw`SELECT * FROM "LobbySocialExposure" WHERE "roundId"=${state.session!.roundId} AND "userId"='e'`).toHaveLength(1);
  });
  it('uses established connection events to freeze and recover the same round',async()=> {
    await setup();
    await moveTime({revealAt:Date.now()-1});const before=await service.snapshot('room','a');
    await command('a','finish');await service.connectionChanged('b',false);
    expect((await service.snapshot('room','a')).session!.members.find(m=>m.userId==='b')!.connected).toBe(false);
    await expect(command('a','override',{text:'تعطل'})).rejects.toThrow('waiting_reconnect');
    await service.connectionChanged('b',true);
    expect((await service.snapshot('room','b')).session!.roundId).toBe(before.session!.roundId);
  });
  it('lets a listener explicitly confirm the next game and excludes unconfirmed players',async()=> {
    await setup();await moveTime({revealAt:Date.now()-1});await service.snapshot('room','a');
    for(const id of ['a','b','c'])await command(id,'finish');
    await command('a','propose',{game:'truth'});
    await command('d','confirm');const switched=await command('a','switch');
    expect(switched.session!.game).toBe('truth');expect(switched.session!.members.find(m=>m.userId==='d')!.role).toBe('player');
    expect(switched.session!.members.find(m=>m.userId==='b')!.role).toBe('listener');
  });
  it('does not broadcast unchanged timer snapshots or rewrite exposure rows on every tick',async()=> {
    await setup();let events=0;service.publish=()=>events++;
    await service.sweep();await service.sweep();expect(events).toBeLessThanOrEqual(1);service.publish=null;
  });
  it('does not mistake recent HTTP activity for recovery from an explicit socket disconnect',async()=> {
    await setup();
    const activeHttpUser={isOnline:()=>true} as unknown as PresenceService;
    const observer=new LobbySocialService(db as PrismaService,config,activeHttpUser);
    await observer.connectionChanged('b',false);await observer.sweep();
    const state=await observer.snapshot('room','a');
    expect(state.session!.members.find(m=>m.userId==='b')!.connected).toBe(false);
    await observer.connectionChanged('b',true);
    expect((await observer.snapshot('room','a')).session!.members.find(m=>m.userId==='b')!.connected).toBe(true);
  });
});
