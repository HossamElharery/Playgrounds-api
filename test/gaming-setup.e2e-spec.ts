const dbUrl=process.env.TEST_DATABASE_URL??'';
const parsed=new URL(dbUrl);
if(!['localhost','127.0.0.1'].includes(parsed.hostname)||!/^\/matchena_gaming_test_[a-z0-9_]+$/.test(parsed.pathname))throw new Error('Dedicated local gaming database required');
process.env.DATABASE_URL=dbUrl;
import { PartnersService } from '../src/modules/partners/partners.service';
import { validateRegistrationGamingPlan } from '../src/modules/partners/registration-gaming-setup';
import { randomUUID } from 'crypto';
import { PrismaService } from '../src/modules/prisma/prisma.service';
import { GamingCommandService } from '../src/modules/owner/gaming/gaming-command.service';
import { GamingLayoutService } from '../src/modules/owner/gaming/gaming-layout.service';
import { GamingSetupService } from '../src/modules/owner/gaming/gaming-setup.service';
import { GamingSessionsService } from '../src/modules/owner/gaming/gaming-sessions.service';
import { GamingReceiptsService } from '../src/modules/owner/gaming/gaming-receipts.service';
import { CommissionService } from '../src/modules/finance/commission.service';
import { LedgerService } from '../src/modules/finance/ledger.service';
import { AuthenticatedUser } from '../src/common/types/authenticated-user.interface';
import { GamingSetupDto } from '../src/modules/owner/gaming/gaming-setup.dto';
import type { LayoutDocument } from '../src/modules/owner/gaming/layout-document';
import { calculateUsageCharge } from '../src/modules/owner/gaming/session-billing';
jest.setTimeout(120000);
describe('guided setup + multi pricing on PostgreSQL',()=>{
 const db=new PrismaService(),commands=new GamingCommandService(db),layouts=new GamingLayoutService(db),setup=new GamingSetupService(commands,layouts),sessions=new GamingSessionsService(commands,new LedgerService(db,new CommissionService(db,{} as never))),receipts=new GamingReceiptsService(commands,sessions);
 let user:AuthenticatedUser,sportId:string;
 const key=(venueId:string)=>({venueId,requestKey:randomUUID()});
 const plan=(venueId:string):GamingSetupDto=>({...key(venueId),groups:[{assetKey:'ps5',count:6,hourlyRateMinor:12000,multiHourlyRateMinor:18000,privateHourlyRateMinor:15000,privateMultiHourlyRateMinor:24000,floorIndex:0}],rooms:[{name:'VIP',floorIndex:1,occupancy:'independent',members:[{assetKey:'ps5',count:2}]}],floorCount:2,arrangement:'rows',ambience:'neon',language:'ar',expectedRevision:0,reuseExisting:false});
 const venue=async()=>db.venue.create({data:{ownerId:user.id,slug:randomUUID(),nameAr:'محل التجهيز',nameEn:'Setup hall',lat:30,lng:31,geohash:'sv8',status:'active',approvedAt:new Date(),sports:{create:{sportId}}}});
 beforeAll(async()=>{
  await db.countryConfig.upsert({where:{code:'EG'},create:{code:'EG',nameAr:'مصر',nameEn:'Egypt',currency:'EGP',phoneCallingCode:'+20',timezone:'Africa/Cairo',weekendDays:[5,6],paymentMethods:['cash']},update:{}});
  const u=await db.user.create({data:{name:'Setup owner',phone:'+201099991123',roles:['owner']}});user={id:u.id,name:u.name,phone:u.phone!,roles:['owner']};
  sportId=(await db.sportCategory.create({data:{slug:'setup-fixture',nameAr:'ألعاب',nameEn:'Gaming',icon:'gamepad',accentColor:'#22cc88',activityKind:'gaming-station'}})).id;
 });
 afterAll(()=>db.$disconnect());
 it('approves registration into one ready hall, preserves fourteen physical devices and does not rerun setup on profile edits',async()=>{
  const d=plan(randomUUID());d.floorCount=1;d.rooms=[{name:'VIP',floorIndex:0,occupancy:'independent',members:[{assetKey:'ps5',count:2}]}];d.groups=[{assetKey:'ps5',count:14,floorIndex:0,hourlyRateMinor:10000,multiHourlyRateMinor:15000,privateHourlyRateMinor:12000,privateMultiHourlyRateMinor:18000}];
  validateRegistrationGamingPlan(d);
  const service=new PartnersService(db,{} as never,{} as never,{} as never,{} as never);
  const payload={publicNameEn:'Registration gaming '+randomUUID(),publicNameAr:'محل التسجيل',countryCode:'EG',lat:30,lng:31,weeklyHours:{},photos:[],gamingSetup:d,courts:Array.from({length:14},(_,i)=>({name:'PS5 '+(i+1),sportId,surface:'other',indoor:true,format:'station',slotDurationMins:60,basePriceAmount:10000,peakPriceAmount:10000,spec:{consoleType:'ps5',seats:4,roomTier:'standard'}}))};
  const venueId=await db.$transaction<string>(tx=>(service as any).publishVenue(tx,user.id,user.id,payload,null),{timeout:30000});
  expect(await db.court.count({where:{venueId}})).toBe(14);expect(await db.gamingRoom.count({where:{venueId}})).toBe(1);expect((await layouts.read(user,venueId)).revision).toBe(1);expect((await setup.status(user,venueId)).eligible).toBe(false);
  const open=await db.court.findFirstOrThrow({where:{venueId,gamingRoomId:null}});expect(open.gamingConfig).toMatchObject({multiHourlyRateMinor:15000});
  const session=await sessions.start(user,{...key(venueId),unitId:open.id,startMode:'now',playMode:'multi'});expect((await db.usageSegment.findFirstOrThrow({where:{sessionId:session.id}})).hourlyRateMinor).toBe(15000);
  await db.$transaction(tx=>(service as any).publishVenue(tx,user.id,user.id,{...payload,publicNameAr:'اسم جديد'},venueId),{timeout:30000});
  expect(await db.court.count({where:{venueId}})).toBe(14);expect((await layouts.read(user,venueId)).revision).toBe(1);expect((await db.usageSegment.findFirstOrThrow({where:{sessionId:session.id}})).hourlyRateMinor).toBe(15000);
 });
 it('approves mixed tables and a whole-room tariff, and rolls invalid inventories back atomically',async()=>{
  const billiards=await db.sportCategory.upsert({where:{slug:'billiards'},create:{slug:'billiards',nameAr:'بلياردو',nameEn:'Billiards',icon:'table',accentColor:'#22cc88',activityKind:'table-game'},update:{}}),tennis=await db.sportCategory.upsert({where:{slug:'table-tennis'},create:{slug:'table-tennis',nameAr:'بينغ بونغ',nameEn:'Table tennis',icon:'table',accentColor:'#22cc88',activityKind:'table-game'},update:{}});
  const d=plan(randomUUID());d.floorCount=1;d.groups=[{assetKey:'ps5',count:2,hourlyRateMinor:10000,multiHourlyRateMinor:15000,floorIndex:0},{assetKey:'billiards',count:2,hourlyRateMinor:8000,floorIndex:0},{assetKey:'table-tennis',count:1,hourlyRateMinor:6000,floorIndex:0}];d.rooms=[{name:'غرفة كاملة',floorIndex:0,occupancy:'exclusive',members:[{assetKey:'ps5',count:2}],hourlyRateMinor:20000,multiHourlyRateMinor:25000}];
  const service=new PartnersService(db,{} as never,{} as never,{} as never,{} as never);
  const sports=[sportId,sportId,billiards.id,billiards.id,tennis.id],payload={publicNameEn:'Mixed setup '+randomUUID(),publicNameAr:'محل ألعاب',countryCode:'EG',lat:30,lng:31,weeklyHours:{},photos:[],gamingSetup:d,courts:sports.map((sport,i)=>({name:'Unit '+i,sportId:sport,surface:'other',format:'session',slotDurationMins:60,basePriceAmount:10000,spec:i<2?{consoleType:'ps5'}:{tableType:'snooker'}}))};
  const before=await db.venue.count();await expect(db.$transaction(tx=>(service as any).publishVenue(tx,user.id,user.id,{...payload,courts:payload.courts.slice(1)},null),{timeout:30000})).rejects.toThrow();expect(await db.venue.count()).toBe(before);
  const venueId=await db.$transaction<string>(tx=>(service as any).publishVenue(tx,user.id,user.id,payload,null),{timeout:30000});expect(await db.court.count({where:{venueId}})).toBe(6);expect(await db.court.count({where:{venueId,gamingPublished:false}})).toBe(2);
  const room=await db.gamingRoom.findFirstOrThrow({where:{venueId}});expect(room.occupancy).toBe('exclusive');const session=await sessions.start(user,{...key(venueId),unitId:room.bookableCourtId!,startMode:'now',playMode:'multi'});expect((await db.usageSegment.findFirstOrThrow({where:{sessionId:session.id}})).hourlyRateMinor).toBe(25000);
  expect((await db.court.findFirstOrThrow({where:{venueId,sportId:billiards.id}})).tableConfig).toMatchObject({tableType:'snooker'});
 });
 it('atomically creates totals, room membership, published layout and separate tariffs; exact retry does not duplicate',async()=>{
  const v=await venue(),d=plan(v.id),result=await setup.setup(user,d);
  expect(result.unitCount).toBe(6);expect(await db.court.count({where:{venueId:v.id}})).toBe(6);expect(await db.gamingRoom.count({where:{venueId:v.id}})).toBe(1);
  expect((await setup.setup(user,d)).revision).toBe(result.revision);expect(await db.court.count({where:{venueId:v.id}})).toBe(6);
  const units=await db.court.findMany({where:{venueId:v.id}});expect(units.filter(u=>u.gamingRoomId)).toHaveLength(2);expect(units.filter(u=>u.gamingRoomId).every(u=>u.gamingHourlyRateMinor===15000)).toBe(true);
  expect((await db.venue.findUniqueOrThrow({where:{id:v.id}})).gamingSessionsEnabled).toBe(true);
  await expect(setup.setup(user,{...d,groups:[{...d.groups[0],count:5}]})).rejects.toMatchObject({status:409});
  await expect(setup.setup(user,{...d,...key(v.id),expectedRevision:1})).rejects.toMatchObject({status:409});
 });
 it('reuses existing IDs and generated layout; rejects lower totals without changing anything',async()=>{
  const v=await venue();const old=await db.court.create({data:{venueId:v.id,sportId,name:'My PS5',gamingConfig:{consoleType:'ps5',roomTier:'vip-big-screen'},gamingHourlyRateMinor:6000,pricingRules:{create:{label:'base',startTime:'00:00',endTime:'24:00',daysOfWeek:[],priceAmount:6000,currency:'EGP'}}}});
  const snapshot=await layouts.read(user,v.id);expect((await setup.status(user,v.id)).eligible).toBe(true);const d=plan(v.id);d.reuseExisting=true;d.expectedRevision=snapshot.revision;await setup.setup(user,d);expect(await db.court.count({where:{venueId:v.id}})).toBe(6);expect((await db.court.findUniqueOrThrow({where:{id:old.id}})).name).toBe('My PS5');
 });
 it('classifies a legacy station, preserves its identity, and reaches exactly 14 stations',async()=>{
  const v=await venue(),old=await db.court.create({data:{venueId:v.id,sportId,name:'الجهاز 1',gamingConfig:{consoleType:'playstation'},gamingHourlyRateMinor:6000}});
  expect((await setup.status(user,v.id)).units[0].assetKey).toBeNull();
  const d=plan(v.id);d.floorCount=1;d.rooms=[];d.reuseExisting=true;d.existingUnits=[{unitId:old.id,assetKey:'ps4'}];d.groups=[{assetKey:'ps5',count:8,hourlyRateMinor:20000,multiHourlyRateMinor:25000,floorIndex:0},{assetKey:'ps4',count:6,hourlyRateMinor:10000,multiHourlyRateMinor:15000,floorIndex:0}];
  const result=await setup.setup(user,d);expect(result.unitCount).toBe(14);expect(await db.court.count({where:{venueId:v.id}})).toBe(14);
  const kept=await db.court.findUniqueOrThrow({where:{id:old.id}});expect(kept.name).toBe('الجهاز 1');expect(kept.gamingConfig).toMatchObject({consoleType:'ps4',multiHourlyRateMinor:15000});
  expect((await setup.status(user,v.id)).eligible).toBe(false);
  const session=await sessions.start(user,{...key(v.id),unitId:old.id,startMode:'now',playMode:'multi'});expect((await db.usageSegment.findFirstOrThrow({where:{sessionId:session.id}})).hourlyRateMinor).toBe(15000);
 });
 it('rejects an outdated inventory or an incompatible reclassification without changing devices',async()=>{
  const v=await venue(),old=await db.court.create({data:{venueId:v.id,sportId,name:'PS5',gamingConfig:{consoleType:'ps5'}}});
  const d=plan(v.id);d.reuseExisting=true;d.existingUnits=[{unitId:old.id,assetKey:'billiards'}];await expect(setup.setup(user,d)).rejects.toMatchObject({status:400});
  d.requestKey=randomUUID();d.existingUnits=[{unitId:old.id,assetKey:'ps5'}];const extra=await db.court.create({data:{venueId:v.id,sportId,name:'Second',gamingConfig:{consoleType:'ps5'}}});
  await expect(setup.setup(user,d)).rejects.toMatchObject({status:409});expect(await db.court.count({where:{venueId:v.id}})).toBe(2);expect((await db.court.findUniqueOrThrow({where:{id:extra.id}})).name).toBe('Second');
 });
 it('adds stations after opening without rebuilding the hall and preserves multi tariffs',async()=>{
  const v=await venue();await setup.setup(user,plan(v.id));const before=await db.court.findMany({where:{venueId:v.id},select:{id:true}});const runningUnit=await db.court.findFirstOrThrow({where:{venueId:v.id,gamingRoomId:null}});const running=await sessions.start(user,{...key(v.id),unitId:runningUnit.id,startMode:'now'});
  const result=await sessions.createUnits(user,{...key(v.id),assetKey:'ps5',count:2,namePrefix:'New PS5',hourlyRateMinor:10000,multiHourlyRateMinor:16000});
  expect(await db.court.count({where:{venueId:v.id}})).toBe(8);expect(await db.court.count({where:{id:{in:before.map(u=>u.id)},venueId:v.id}})).toBe(6);expect(result.units.every(u=>!u.gamingPublished)).toBe(true);expect(result.units[0].gamingConfig).toMatchObject({multiHourlyRateMinor:16000,seats:4});expect((await setup.status(user,v.id)).eligible).toBe(false);
  const snapshot=await layouts.read(user,v.id),doc=structuredClone(snapshot.published!) as unknown as LayoutDocument;result.units.forEach((u,i)=>doc.placements.push({id:randomUUID(),unitId:u.id,floorId:doc.floors[0].id,assetKey:'ps5',x:3.4+i*3.8,z:7,rotation:0,width:2.6,depth:2.6,height:1}));
  await layouts.save(user,{venueId:v.id,baseRevision:snapshot.revision,draftVersion:snapshot.draftVersion,document:doc as unknown as Record<string,unknown>});await layouts.publish(user,{...key(v.id),baseRevision:snapshot.revision,draftVersion:snapshot.draftVersion+1});
  const added=await sessions.start(user,{...key(v.id),unitId:result.units[0].id,startMode:'now',playMode:'multi'});expect((await db.usageSegment.findFirstOrThrow({where:{sessionId:added.id}})).hourlyRateMinor).toBe(16000);expect((await db.usageSegment.findFirstOrThrow({where:{sessionId:running.id}})).hourlyRateMinor).toBe(12000);

  await expect(sessions.createUnits(user,{...key(v.id),assetKey:'pc',count:1,namePrefix:'PC',hourlyRateMinor:10000,multiHourlyRateMinor:16000})).rejects.toMatchObject({status:400});expect(await db.court.count({where:{venueId:v.id}})).toBe(8);
 });
 it('two concurrent setup requests leave one complete hall',async()=>{const v=await venue();const r=await Promise.allSettled([setup.setup(user,plan(v.id)),setup.setup(user,plan(v.id))]);expect(r.filter(x=>x.status==='fulfilled')).toHaveLength(1);expect(await db.court.count({where:{venueId:v.id}})).toBe(6);expect(await db.gamingLayoutRevision.count({where:{venueId:v.id}})).toBe(1);});
 it('invalid over-allocation rolls back; foreign owner and unapproved venue are denied',async()=>{const v=await venue(),d=plan(v.id);d.rooms[0].members[0].count=7;await expect(setup.setup(user,d)).rejects.toMatchObject({status:400});expect(await db.court.count({where:{venueId:v.id}})).toBe(0);await expect(setup.setup({...user,id:randomUUID()},plan(v.id))).rejects.toThrow();await db.venue.update({where:{id:v.id},data:{approvedAt:null}});await expect(setup.setup(user,plan(v.id))).rejects.toMatchObject({status:403});});
 it('whole-room setup publishes one parent; its session occupies children and charges the room tariff once',async()=>{const v=await venue(),d=plan(v.id);d.rooms[0].occupancy='exclusive';d.rooms[0].hourlyRateMinor=30000;d.rooms[0].multiHourlyRateMinor=40000;await setup.setup(user,d);const room=await db.gamingRoom.findFirstOrThrow({where:{venueId:v.id}});const s=await sessions.start(user,{...key(v.id),unitId:room.bookableCourtId!,startMode:'now',playMode:'multi'});const children=await db.court.findMany({where:{gamingRoomId:room.id}});expect(children.every(u=>!u.gamingPublished)).toBe(true);const published=await layouts.read(user,v.id);await layouts.save(user,{venueId:v.id,baseRevision:published.revision,draftVersion:published.draftVersion,document:published.published as Record<string,unknown>});await layouts.publish(user,{...key(v.id),baseRevision:published.revision,draftVersion:published.draftVersion+1});expect((await db.court.findMany({where:{gamingRoomId:room.id}})).every(u=>!u.gamingPublished)).toBe(true);expect(await db.resourceOccupancy.count({where:{sessionId:s.id,running:true}})).toBe(3);expect((await db.usageSegment.findFirstOrThrow({where:{sessionId:s.id}})).hourlyRateMinor).toBe(40000);});
 it('multi transfer/mode change snapshots rates; price edits cannot reprice old legs; receipt states the mode',async()=>{
  const v=await venue();await setup.setup(user,plan(v.id));const units=await db.court.findMany({where:{venueId:v.id,gamingRoomId:null},orderBy:{name:'asc'}});
  const s=await sessions.start(user,{...key(v.id),unitId:units[0].id,startMode:'now',playMode:'multi'});
  const first=await db.usageSegment.findFirstOrThrow({where:{sessionId:s.id}});expect(first.hourlyRateMinor).toBe(18000);
  await sessions.tariffs(user,{...key(v.id),unitId:units[0].id,hourlyRateMinor:9000,multiHourlyRateMinor:27000});
  expect((await db.usageSegment.findUniqueOrThrow({where:{id:first.id}})).hourlyRateMinor).toBe(18000);
  const switched=await sessions.changePlayMode(user,s.id,{...key(v.id),expectedVersion:1,playMode:'standard'});
  await sessions.transfer(user,s.id,{...key(v.id),expectedVersion:switched.version,targetUnitId:units[1].id});
  const current=await db.usageSession.findUniqueOrThrow({where:{id:s.id},include:{segments:{orderBy:{startedAt:'asc'}}}});
  expect(current.segments.map(g=>g.hourlyRateMinor)).toEqual([18000,9000,12000]);
  await expect(sessions.changePlayMode(user,s.id,{...key(v.id),expectedVersion:1,playMode:'multi'})).rejects.toMatchObject({status:409});
  await sessions.end(user,s.id,{...key(v.id),expectedVersion:current.version});
  const bill=await receipts.bill(user,s.orderId,{...key(v.id)});const snapshot=bill.snapshot as unknown as {lines:{snapshot:{detail:{playMode:string}[]}}[]};expect(snapshot.lines[0].snapshot.detail.map(g=>g.playMode)).toEqual(['multi','standard','standard']);
  const now=Date.now(),fixture={...current,endedAt:new Date(now),segments:[{...current.segments[0],startedAt:new Date(now-30*60000),endedAt:new Date(now-20*60000),hourlyRateMinor:18000},{...current.segments[1],startedAt:new Date(now-20*60000),endedAt:new Date(now),hourlyRateMinor:9000}]};expect(calculateUsageCharge(fixture,new Date(now))).toBe(6000);
 });
 it('venue management alone cannot set prices/publish and revoked permissions block a replay',async()=>{
  const v=await venue();const staff=await db.user.create({data:{name:'Setup staff',phone:'+201099991124',roles:['staff']}});await db.staffMember.create({data:{userId:staff.id,ownerId:user.id,createdById:user.id,venueIds:[v.id],permissions:['venue.manage','bookings.view']}});const actor={id:staff.id,name:staff.name,phone:staff.phone!,roles:['staff']} as AuthenticatedUser;const d=plan(v.id);
  await expect(setup.setup(actor,d)).rejects.toMatchObject({status:403});expect(await db.court.count({where:{venueId:v.id}})).toBe(0);
  await db.staffMember.update({where:{userId:staff.id},data:{permissions:['venue.manage','bookings.view','pricing.manage','layout.view','layout.edit','layout.publish']}});await setup.setup(actor,d);await db.staffMember.update({where:{userId:staff.id},data:{permissions:['venue.manage','bookings.view']}});await expect(setup.setup(actor,d)).rejects.toMatchObject({status:403});
 });
 it('splits one station type across floors without counting room stations twice',async()=>{const v=await venue(),d=plan(v.id);d.groups[0].floorCounts=[2,2];const result=await setup.setup(user,d);expect(result.document.placements.filter(p=>p.unitId&&p.floorId===result.document.floors[0].id)).toHaveLength(2);expect(result.document.placements.filter(p=>p.unitId&&p.floorId===result.document.floors[1].id)).toHaveLength(4);});
 it('saving station tariffs also repairs a missing base rule so the station can start',async()=>{const v=await venue();await setup.setup(user,plan(v.id));const unit=await db.court.findFirstOrThrow({where:{venueId:v.id,gamingRoomId:null}});await db.pricingRule.deleteMany({where:{courtId:unit.id}});await sessions.tariffs(user,{...key(v.id),unitId:unit.id,hourlyRateMinor:6000,multiHourlyRateMinor:9000});const s=await sessions.start(user,{...key(v.id),unitId:unit.id,startMode:'now',playMode:'multi'});expect((await db.usageSegment.findFirstOrThrow({where:{sessionId:s.id}})).hourlyRateMinor).toBe(9000);});
 it('100-station setup remains atomic and completes within the transaction budget',async()=>{const v=await venue(),d=plan(v.id);d.groups[0].count=100;d.rooms=[];d.floorCount=1;const start=Date.now();const result=await setup.setup(user,d);expect(result.unitCount).toBe(100);expect(await db.court.count({where:{venueId:v.id}})).toBe(100);console.info('guided-setup-100-stations-ms',Date.now()-start);});
 it('missing destination multi price preserves the original session atomically',async()=>{const v=await venue();await setup.setup(user,plan(v.id));const units=await db.court.findMany({where:{venueId:v.id,gamingRoomId:null}});await sessions.tariffs(user,{...key(v.id),unitId:units[1].id,hourlyRateMinor:12000});const s=await sessions.start(user,{...key(v.id),unitId:units[0].id,startMode:'now',playMode:'multi'});await expect(sessions.transfer(user,s.id,{...key(v.id),expectedVersion:1,targetUnitId:units[1].id})).rejects.toMatchObject({status:400});expect((await db.usageSession.findUniqueOrThrow({where:{id:s.id}})).unitId).toBe(units[0].id);expect(await db.usageSegment.count({where:{sessionId:s.id}})).toBe(1);});
});
