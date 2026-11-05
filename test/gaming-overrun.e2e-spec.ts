const dbUrl=process.env.TEST_DATABASE_URL??'';
const parsed=new URL(dbUrl);
if(!['localhost','127.0.0.1'].includes(parsed.hostname)||!/^\/matchena_gaming_test_[a-z0-9_]+$/.test(parsed.pathname))throw new Error('Dedicated local gaming database required');
process.env.DATABASE_URL=dbUrl;
import { randomUUID } from 'crypto';
import { PrismaService } from '../src/modules/prisma/prisma.service';
import { GamingCommandService } from '../src/modules/owner/gaming/gaming-command.service';
import { GamingSessionsService } from '../src/modules/owner/gaming/gaming-sessions.service';
import { GamingOutboxService } from '../src/modules/owner/gaming/gaming-outbox.service';
import { CommissionService } from '../src/modules/finance/commission.service';
import { LedgerService } from '../src/modules/finance/ledger.service';
import { AuthenticatedUser } from '../src/common/types/authenticated-user.interface';
jest.setTimeout(120000);

describe('what a timed session is billed after its planned end (PostgreSQL)',()=>{
  const db=new PrismaService();const commands=new GamingCommandService(db);const ledger=new LedgerService(db,new CommissionService(db,{} as never));
  const sessions=new GamingSessionsService(commands,ledger);
  const notifications={create:jest.fn().mockResolvedValue(null)};
  let user:AuthenticatedUser;let venueId:string;let units:string[];
  const key=()=>({venueId,requestKey:randomUUID()});
  const MIN=60_000;
  const billing=(overrun?:'stop'|'continue'|'auto-end')=>sessions.billing(user,{...key(),mode:'exact-time',minimumMinutes:0,stepMinutes:5,...(overrun?{overrun}:{})});
  /** Pretend the session began `startedAgo` minutes ago and was planned to end `endedAgo` minutes ago. */
  const age=async(id:string,startedAgo:number,plannedEndAgo:number)=>{
    const s=await db.usageSession.findUniqueOrThrow({where:{id}});
    const startedAt=new Date(Date.now()-startedAgo*MIN);
    // the database checks segments against the session when the transaction commits, so both move together
    await db.$transaction([db.usageSegment.updateMany({where:{sessionId:id},data:{startedAt}}),db.usageSession.update({where:{id},data:{startedAt,expectedEnd:new Date(Date.now()-plannedEndAgo*MIN)}})]);
    return s;
  };
  const total=async(orderId:string)=>(await db.gamingOrder.findUniqueOrThrow({where:{id:orderId}})).totalMinor;
  const fresh=async(unit:number,minutes=10)=>sessions.start(user,{...key(),unitId:units[unit],startMode:'now',durationMinutes:minutes});

  beforeAll(async()=>{
    await db.countryConfig.upsert({where:{code:'EG'},create:{code:'EG',nameAr:'مصر',nameEn:'Egypt',currency:'EGP',phoneCallingCode:'+20',timezone:'Africa/Cairo',weekendDays:[5,6],paymentMethods:['cash']},update:{}});
    const o=await db.user.create({data:{name:'Overrun fixture',phone:'+201099990094',roles:['owner']}});user={id:o.id,name:o.name,phone:o.phone!,roles:['owner']};
    const v=await db.venue.create({data:{slug:'overrun-fixture-a',nameAr:'محل الوقت',nameEn:'Overrun test',ownerId:o.id,lat:30,lng:31,geohash:'sv8',status:'active',approvedAt:new Date(),gamingSessionsEnabled:true}});venueId=v.id;
    const sport=await db.sportCategory.create({data:{slug:'overrun-fixture',nameAr:'ألعاب',nameEn:'Gaming',icon:'gamepad',accentColor:'#22cc88',activityKind:'gaming-station'}});
    units=[];for(let i=0;i<5;i++){const unit=await db.court.create({data:{venueId,sportId:sport.id,name:`Station ${i+1}`,gamingConfig:{consoleType:'ps5',seats:2,roomTier:'standard'},pricingRules:{create:{label:'base',daysOfWeek:[],startTime:'00:00',endTime:'24:00',priceAmount:12000,currency:'EGP'}}}});units.push(unit.id);}
  });
  afterAll(async()=>{await db.$disconnect();});

  it('the default for a venue that never chose is "stop the bill"; the choice is kept when billing is saved without it',async()=>{
    expect((await sessions.capabilities(user,venueId)).billingPolicy).toMatchObject({overrun:'stop'});
    const s=await fresh(0);
    expect((await db.usageSession.findUniqueOrThrow({where:{id:s.id}})).policy).toMatchObject({overrun:'stop'});
    await billing('continue');
    expect((await sessions.capabilities(user,venueId)).billingPolicy).toMatchObject({overrun:'continue'});
    await billing(); // saved again without the option: nothing changes
    expect((await sessions.capabilities(user,venueId)).billingPolicy).toMatchObject({overrun:'continue'});
    await billing('stop');
    await sessions.end(user,s.id,{...key(),expectedVersion:s.version});
  });

  it('stop: the bill is the planned time even when the session is ended much later, on the board and on the bill',async()=>{
    await billing('stop');
    const s=await fresh(1,10);
    await age(s.id,15,5); // planned 10 min, started 15 min ago
    const board=await sessions.board(user,venueId);
    expect(board.units.find(u=>u.id===units[1])!.session).toMatchObject({estimatedMinor:2000,dueToEnd:true});
    const ended=await sessions.end(user,s.id,{...key(),expectedVersion:(await db.usageSession.findUniqueOrThrow({where:{id:s.id}})).version});
    expect(await total(ended.orderId)).toBe(2000);
  });

  it('continue: the clock and the bill keep running (the original behavior)',async()=>{
    await billing('continue');
    const s=await fresh(2,10);
    await age(s.id,15,5);
    const ended=await sessions.end(user,s.id,{...key(),expectedVersion:(await db.usageSession.findUniqueOrThrow({where:{id:s.id}})).version});
    expect(await total(ended.orderId)).toBe(3000);
    await billing('stop');
  });

  it('stop: extending after the time is up does not bill the wait; extending in time changes nothing',async()=>{
    const s=await fresh(3,10);
    await age(s.id,15,5);
    const v=(await db.usageSession.findUniqueOrThrow({where:{id:s.id}})).version;
    const extended=await sessions.extend(user,s.id,{...key(),expectedVersion:v,additionalMinutes:10});
    const row=await db.usageSession.findUniqueOrThrow({where:{id:s.id}});
    const paused=(row.policy as {pausedMs?:number}).pausedMs!;
    expect(paused).toBeGreaterThan(4.9*MIN);expect(paused).toBeLessThan(5.2*MIN);
    expect(Date.parse(String(extended.expectedEnd))-Date.now()).toBeGreaterThan(9.8*MIN);
    const board=await sessions.board(user,venueId);
    const est=board.units.find(u=>u.id===units[3])!.session!.estimatedMinor!;
    expect(est).toBeGreaterThanOrEqual(1990);expect(est).toBeLessThanOrEqual(2050); // 15 min elapsed - 5 min paused = 10 min
    const again=await sessions.extend(user,s.id,{...key(),expectedVersion:row.version,additionalMinutes:5});
    expect((await db.usageSession.findUniqueOrThrow({where:{id:s.id}})).policy).toMatchObject({pausedMs:paused});
    await sessions.end(user,s.id,{...key(),expectedVersion:(await db.usageSession.findUniqueOrThrow({where:{id:s.id}})).version});
    expect(again).toBeTruthy();
  });

  it('auto-end: the session closes at its planned end by itself, once, only when due, and tells the team',async()=>{
    await billing('auto-end');
    const s=await fresh(4,10);
    expect(await sessions.autoEnd(s.id)).toBeNull(); // not due yet
    await age(s.id,15,5);
    const outbox=new GamingOutboxService(db,{} as never,notifications as never,sessions);
    await outbox.autoEnd();
    const row=await db.usageSession.findUniqueOrThrow({where:{id:s.id},include:{segments:true}});
    expect(row.state).toBe('ended');
    expect(row.endedAt!.getTime()).toBe(row.expectedEnd!.getTime()); // closed at the planned end, not when the job ran
    expect(await total(row.orderId)).toBe(2000);
    expect(notifications.create).toHaveBeenCalledWith(expect.objectContaining({userId:user.id,titleEn:expect.stringContaining('session ended')}));
    notifications.create.mockClear();
    await outbox.autoEnd();
    expect(notifications.create).not.toHaveBeenCalled();
    expect(await sessions.autoEnd(s.id)).toBeNull();
    expect((await db.auditLogEntry.count({where:{action:'owner.gaming.session.auto-ended',targetId:s.id}}))).toBe(1);
    await billing('stop');
  });

  it('a bill left unpaid after the session ended keeps reminding the team, on a schedule, and not before three minutes',async()=>{
    await billing('auto-end');
    const outbox=new GamingOutboxService(db,{} as never,notifications as never,sessions);
    const recent=await fresh(4,10);
    const orderId=(await db.usageSession.findUniqueOrThrow({where:{id:recent.id}})).orderId;
    // other tests in this venue leave bills too, so look only at this one
    const mine=()=>notifications.create.mock.calls.map(c=>c[0]).filter((n:{payload?:{orderId?:string}})=>n.payload?.orderId===orderId);
    await age(recent.id,5,2); // planned to end 2 minutes ago
    await outbox.autoEnd();
    const endedAt=async(minutesAgo:number)=>{const at=new Date(Date.now()-minutesAgo*MIN),from=new Date(at.getTime()-5*MIN);await db.$transaction([db.usageSegment.updateMany({where:{sessionId:recent.id},data:{startedAt:from,endedAt:at}}),db.usageSession.update({where:{id:recent.id},data:{startedAt:from,expectedEnd:at,endedAt:at}})]);notifications.create.mockClear();await outbox.unpaidReminders();};
    await endedAt(2);
    expect(mine()).toHaveLength(0); // too early to nag
    await endedAt(10);
    expect(mine()).toEqual([expect.objectContaining({userId:user.id,titleEn:expect.stringContaining('bill not collected'),dedupKey:expect.stringContaining(':1:')})]);
    await endedAt(13*60);
    expect(mine()).toHaveLength(0); // a bill from yesterday's shift is not nagged about
    await billing('stop');
  });
  it('open sessions and booking sessions are not touched by any of this',async()=>{
    await billing('auto-end');
    const open=await sessions.start(user,{...key(),unitId:units[0],startMode:'now'});
    const startedAt=new Date(Date.now()-60*MIN);
    await db.$transaction([db.usageSegment.updateMany({where:{sessionId:open.id},data:{startedAt}}),db.usageSession.update({where:{id:open.id},data:{startedAt}})]);
    await new GamingOutboxService(db,{} as never,notifications as never,sessions).autoEnd();
    expect((await db.usageSession.findUniqueOrThrow({where:{id:open.id}})).state).toBe('running');
    await sessions.end(user,open.id,{...key(),expectedVersion:open.version});
    await billing('stop');
  });
});
