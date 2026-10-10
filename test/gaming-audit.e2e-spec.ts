import 'reflect-metadata';
const dbUrl=process.env.TEST_DATABASE_URL??'';
const parsed=new URL(dbUrl);
if(!['localhost','127.0.0.1'].includes(parsed.hostname)||!/^\/matchena_gaming_test_[a-z0-9_]+$/.test(parsed.pathname))throw new Error('Dedicated local gaming database required');
process.env.DATABASE_URL=dbUrl;
import {randomUUID} from 'crypto';
import {PrismaService} from '../src/modules/prisma/prisma.service';
import {GamingCommandService} from '../src/modules/owner/gaming/gaming-command.service';
import {GamingLayoutService} from '../src/modules/owner/gaming/gaming-layout.service';
import {GamingSetupService} from '../src/modules/owner/gaming/gaming-setup.service';
import {GamingSessionsService} from '../src/modules/owner/gaming/gaming-sessions.service';
import {GamingCommerceService} from '../src/modules/owner/gaming/gaming-commerce.service';
import {GamingReceiptsService} from '../src/modules/owner/gaming/gaming-receipts.service';
import {LedgerService} from '../src/modules/finance/ledger.service';
import {CommissionService} from '../src/modules/finance/commission.service';
import {PartnersService} from '../src/modules/partners/partners.service';
import {AuthenticatedUser} from '../src/common/types/authenticated-user.interface';
import {GamingSetupDto} from '../src/modules/owner/gaming/gaming-setup.dto';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import request = require('supertest');
import { GamingSetupController } from '../src/modules/owner/gaming/gaming-setup.controller';
import { GamingOperationsController } from '../src/modules/owner/gaming/gaming-operations.controller';
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
jest.setTimeout(120000);
describe('gaming release audit: real PostgreSQL cross-module regressions',()=>{
 const db=new PrismaService(),commands=new GamingCommandService(db),layouts=new GamingLayoutService(db),setup=new GamingSetupService(commands,layouts),sessions=new GamingSessionsService(commands,new LedgerService(db,new CommissionService(db,{} as never))),receipts=new GamingReceiptsService(commands,sessions),commerce=new GamingCommerceService(commands,sessions,receipts);
 let owner:AuthenticatedUser,sportId:string;
 const key=(venueId:string)=>({venueId,requestKey:randomUUID()});
 const plan=(venueId:string):GamingSetupDto=>({...key(venueId),groups:[{assetKey:'ps5',count:3,hourlyRateMinor:6000,multiHourlyRateMinor:12000,floorIndex:0}],rooms:[],floorCount:1,arrangement:'rows',ambience:'neon',language:'ar',expectedRevision:0,reuseExisting:false});
 async function hall(countryCode='EG'){const v=await db.venue.create({data:{ownerId:owner.id,slug:randomUUID(),nameAr:'صالة مراجعة',nameEn:'Audit hall',lat:30,lng:31,geohash:'sv8',status:'active',approvedAt:new Date(),countryCode,currency:countryCode==='BH'?'BHD':'EGP',sports:{create:{sportId}}}});return v;}
 const version=async(id:string)=>(await db.gamingOrder.findUniqueOrThrow({where:{id}})).version;
 beforeAll(async()=>{
  for(const [code,currency,timezone,phoneCallingCode]of [['EG','EGP','Africa/Cairo','+20'],['BH','BHD','Asia/Bahrain','+973']])await db.countryConfig.upsert({where:{code},create:{code,currency,timezone,phoneCallingCode,nameAr:code,nameEn:code,weekendDays:[5,6],paymentMethods:['cash']},update:{}});
  const u=await db.user.create({data:{name:'Audit owner',phone:'+201099993001',roles:['owner']}});owner={id:u.id,name:u.name,phone:u.phone!,roles:['owner']};
  sportId=(await db.sportCategory.create({data:{slug:'audit-ps-fixture',nameAr:'بلايستيشن',nameEn:'PS',icon:'gamepad',accentColor:'#22cc88',activityKind:'gaming-station'}})).id;
 });
 afterAll(()=>db.$disconnect());
 it('real pricing-rule edits invalidate old standard rates; board displays the new rate, multi stays explicit, and old legs keep their snapshot',async()=>{
  const v=await hall();await setup.setup(owner,plan(v.id));const u=await db.court.findFirstOrThrow({where:{venueId:v.id}});
  const old=await sessions.start(owner,{...key(v.id),unitId:u.id,startMode:'now'});await sessions.end(owner,old.id,{...key(v.id),expectedVersion:1});
  await db.pricingRule.updateMany({where:{courtId:u.id},data:{priceAmount:9000}});
  expect((await sessions.board(owner,v.id)).units.find(x=>x.id===u.id)?.hourlyRateMinor).toBe(9000);
  const next=await sessions.start(owner,{...key(v.id),unitId:u.id,startMode:'now',playMode:'multi'});expect((await db.usageSegment.findFirstOrThrow({where:{sessionId:next.id}})).hourlyRateMinor).toBe(12000);expect((await db.usageSegment.findFirstOrThrow({where:{sessionId:old.id}})).hourlyRateMinor).toBe(6000);
 });
 it('standard time-window tariffs win over the base, including the rate displayed to the operator',async()=>{
  const v=await hall();await setup.setup(owner,plan(v.id));const u=await db.court.findFirstOrThrow({where:{venueId:v.id}});
  await db.pricingRule.create({data:{courtId:u.id,label:'peak',daysOfWeek:[],startTime:'00:00',endTime:'24:00',priority:10,priceAmount:15000,currency:'EGP'}});
  const b=(await sessions.board(owner,v.id)).units.find(x=>x.id===u.id)!;expect(b.hourlyRateMinor).toBe(15000);expect(b.baseHourlyRateMinor).toBe(6000);
  const s=await sessions.start(owner,{...key(v.id),unitId:u.id,startMode:'now'});expect((await db.usageSegment.findFirstOrThrow({where:{sessionId:s.id}})).hourlyRateMinor).toBe(15000);
 });
 it('tariff edits and reused-unit setup retain all three ISO fractional digits despite pricing-change triggers',async()=>{
  const v=await hall('BH');const u=await db.court.create({data:{venueId:v.id,sportId,name:'Old PS5',gamingConfig:{consoleType:'ps5'},pricingRules:{create:{label:'base',daysOfWeek:[],startTime:'00:00',endTime:'24:00',priceAmount:100,currency:'BHD'}}}});
  const d=plan(v.id);d.reuseExisting=true;d.groups[0].hourlyRateMinor=1234;d.groups[0].multiHourlyRateMinor=2345;await setup.setup(owner,d);
  expect((await db.court.findUniqueOrThrow({where:{id:u.id}})).gamingHourlyRateMinor).toBe(1234);
  await sessions.tariffs(owner,{...key(v.id),unitId:u.id,hourlyRateMinor:1567,multiHourlyRateMinor:2789});
  const b=(await sessions.board(owner,v.id)).units.find(x=>x.id===u.id)!;expect(b.hourlyRateMinor).toBe(1567);expect(b.multiHourlyRateMinor).toBe(2789);
  const s=await sessions.start(owner,{...key(v.id),unitId:u.id,startMode:'now'});expect((await db.usageSegment.findFirstOrThrow({where:{sessionId:s.id}})).hourlyRateMinor).toBe(1567);
 });
 it('a currently confirmed reservation is exposed for check-in and links the original booking charge exactly once',async()=>{
  const v=await hall();await setup.setup(owner,plan(v.id));const u=await db.court.findFirstOrThrow({where:{venueId:v.id}});const now=Date.now();
  const booking=await db.booking.create({data:{venueId:v.id,courtId:u.id,userId:owner.id,code:randomUUID(),status:'confirmed',source:'manual',slotStart:new Date(now-60000),slotEnd:new Date(now+1800000),baseAmount:3000,totalAmount:3000}});
  const current=(await sessions.board(owner,v.id)).units.find(x=>x.id===u.id)!;expect(current.state).toBe('held');expect(current.currentBooking?.id).toBe(booking.id);
  const d={...key(v.id),unitId:u.id,startMode:'now' as const,bookingId:booking.id};const s=await sessions.start(owner,d);expect((await sessions.start(owner,d)).id).toBe(s.id);expect(await db.gamingOrderLine.count({where:{orderId:s.orderId,kind:'booking-time'}})).toBe(1);
 });
 it('layout-only staff can see placement metadata but never the multi tariff inside config JSON',async()=>{
  const v=await hall();await setup.setup(owner,plan(v.id));const user=await db.user.create({data:{name:'Layout staff',phone:'+201099993002',roles:['staff']}});await db.staffMember.create({data:{userId:user.id,ownerId:owner.id,createdById:owner.id,venueIds:[v.id],permissions:['bookings.view','layout.view']}});const actor={id:user.id,name:user.name,phone:user.phone!,roles:['staff']} as AuthenticatedUser;
  const layout=await layouts.read(actor,v.id);expect(layout.units[0].gamingConfig).toHaveProperty('consoleType','ps5');expect(layout.units[0].gamingConfig).not.toHaveProperty('multiHourlyRateMinor');expect((await sessions.board(actor,v.id)).units[0]).not.toHaveProperty('hourlyRateMinor');
 });
 it('fully paid ended bills close automatically; settlement documents are stable; a refund reopens the balance',async()=>{
  const v=await hall();await setup.setup(owner,plan(v.id));const u=await db.court.findFirstOrThrow({where:{venueId:v.id}});const s=await sessions.start(owner,{...key(v.id),unitId:u.id,startMode:'manual',startsAt:new Date(Date.now()-45000).toISOString()});await sessions.end(owner,s.id,{...key(v.id),expectedVersion:1});const order=await commerce.detail(owner,s.orderId);
  const payment=await commerce.collect(owner,order.id,{...key(v.id),expectedVersion:order.version,amountMinor:order.totalMinor,method:'cash'});expect(payment.order.state).toBe('settled');expect((await commerce.list(owner,v.id,undefined,'open')).items.map(o=>o.id)).not.toContain(order.id);
  const a=await commerce.settle(owner,order.id,{...key(v.id),expectedVersion:await version(order.id)});const b=await commerce.settle(owner,order.id,{...key(v.id),expectedVersion:await version(order.id)});expect(b.receiptId).toBe(a.receiptId);
  await commerce.refund(owner,order.id,{...key(v.id),expectedVersion:await version(order.id),paymentId:payment.paymentId,amountMinor:1,reason:'Audit partial refund'});expect((await commerce.detail(owner,order.id)).state).toBe('open');expect((await commerce.detail(owner,order.id)).remainingMinor).toBe(1);
 });
 it('discounts use the refreshed running-time bill instead of the stale stored total',async()=>{
  const v=await hall();const d=plan(v.id);d.groups[0].hourlyRateMinor=10000000;await setup.setup(owner,d);const u=await db.court.findFirstOrThrow({where:{venueId:v.id}});const s=await sessions.start(owner,{...key(v.id),unitId:u.id,startMode:'now'});
  expect((await db.gamingOrder.findUniqueOrThrow({where:{id:s.orderId}})).totalMinor).toBe(0);
  await expect(commerce.discount(owner,s.orderId,{...key(v.id),expectedVersion:await version(s.orderId),amountMinor:1,reason:'Audit discount'})).resolves.toHaveProperty('totalMinor');expect(await db.gamingOrderLine.count({where:{orderId:s.orderId,kind:'discount'}})).toBe(1);
 });
 it('reapproving a stale registration cannot delete operational units, erase multi rates, duplicate rooms, or replace the retained logo photo ID',async()=>{
  const v=await hall(),d=plan(v.id);d.rooms=[{name:'Whole VIP',floorIndex:0,occupancy:'exclusive',members:[{assetKey:'ps5',count:2}],hourlyRateMinor:18000,multiHourlyRateMinor:24000}];await setup.setup(owner,d);
  const photo=await db.venuePhoto.create({data:{venueId:v.id,url:'/uploads/audit-logo.webp'}});const before=await db.court.findMany({where:{venueId:v.id},orderBy:{id:'asc'},include:{pricingRules:{orderBy:{id:'asc'}}}});
  const partner=new PartnersService(db,{} as never,{} as never,{} as never,{} as never);
  const payload={countryCode:'EG',publicNameAr:'المكان المعدل',publicNameEn:'Amended hall',lat:30,lng:31,courts:[{name:'Stale device',sportId,basePriceAmount:100,slotDurationMins:60,spec:{consoleType:'ps4'}}],photos:[{url:photo.url,isCover:true}]};
  await db.$transaction(tx=>(partner as unknown as {publishVenue:(tx:unknown,a:string,o:string,p:unknown,v:string)=>Promise<string>}).publishVenue(tx,owner.id,owner.id,payload,v.id));
  const after=await db.court.findMany({where:{venueId:v.id},orderBy:{id:'asc'},include:{pricingRules:{orderBy:{id:'asc'}}}});expect(after).toEqual(before);expect(await db.venuePhoto.findUnique({where:{id:photo.id}})).not.toBeNull();expect((await db.venue.findUniqueOrThrow({where:{id:v.id}})).nameEn).toBe('Amended hall');
 });
 it('reapproval reuses an unconfigured named station without an ID and covers the final minute of the day',async()=>{
  const v=await hall();const u=await db.court.create({data:{venueId:v.id,sportId,name:'Existing PS5',gamingConfig:{consoleType:'ps5'}}});
  const partner=new PartnersService(db,{} as never,{} as never,{} as never,{} as never);
  const payload={countryCode:'EG',publicNameAr:'محل',publicNameEn:'Unconfigured hall',lat:30,lng:31,courts:[{name:u.name,sportId,basePriceAmount:6000,slotDurationMins:60,spec:{consoleType:'ps5'}}],photos:[]};
  await db.$transaction(tx=>(partner as unknown as {publishVenue:(tx:unknown,a:string,o:string,p:unknown,v:string)=>Promise<string>}).publishVenue(tx,owner.id,owner.id,payload,v.id));
  expect(await db.court.count({where:{venueId:v.id}})).toBe(1);
  expect(await db.court.findUnique({where:{id:u.id}})).not.toBeNull();
  expect((await db.pricingRule.findFirstOrThrow({where:{courtId:u.id,label:'base'}})).endTime).toBe('24:00');
 });

 it('validates the HTTP setup contract, enforces live staff grants, and runs a multi session through the real controllers',async()=>{
  const module=await Test.createTestingModule({controllers:[GamingSetupController,GamingOperationsController],providers:[
   {provide:PrismaService,useValue:db},{provide:GamingSetupService,useValue:setup},{provide:GamingSessionsService,useValue:sessions},
   {provide:GamingCommerceService,useValue:commerce},{provide:GamingReceiptsService,useValue:receipts},
  ]}).compile();
  const app=module.createNestApplication();
  // Only identity transport is replaced; guards re-read real roles and grants from the disposable database.
  const staff=await db.user.findUniqueOrThrow({where:{phone:'+201099993002'}});
  app.use((req:any,_res:any,next:()=>void)=>{if(req.headers['x-fixture-identity']==='owner')req.user={...owner};if(req.headers['x-fixture-identity']==='staff')req.user={id:staff.id,name:staff.name,phone:staff.phone,roles:['staff']};next();});
  app.setGlobalPrefix('api/v1');app.useGlobalPipes(new ValidationPipe({whitelist:true,forbidNonWhitelisted:true,transform:true,transformOptions:{enableImplicitConversion:true}}));
  app.useGlobalInterceptors(new ResponseInterceptor());app.useGlobalFilters(new AllExceptionsFilter());await app.init();
  try{
   const server=app.getHttpServer(),v=await hall(),d=plan(v.id);
   await request(server).get('/api/v1/owner/gaming/board').query({venueId:v.id}).expect(401);
   await request(server).post('/api/v1/owner/gaming/setup').set('x-fixture-identity','staff').send(d).expect(403);
   await request(server).post('/api/v1/owner/gaming/setup').set('x-fixture-identity','owner').send({...d,groups:[{...d.groups[0],hourlyRateMinor:0}]}).expect(400);
   await request(server).post('/api/v1/owner/gaming/setup').set('x-fixture-identity','owner').send(d).expect(201);
   const b=await request(server).get('/api/v1/owner/gaming/board').set('x-fixture-identity','owner').query({venueId:v.id}).expect(200);
   const unit=b.body.result.units[0];expect(unit.multiHourlyRateMinor).toBe(12000);
   const start=await request(server).post('/api/v1/owner/gaming/sessions/start').set('x-fixture-identity','owner').send({...key(v.id),unitId:unit.id,startMode:'now',playMode:'multi'}).expect(201);
   const id=start.body.result.id;expect((await db.usageSegment.findFirstOrThrow({where:{sessionId:id}})).hourlyRateMinor).toBe(12000);
   await request(server).post(`/api/v1/owner/gaming/sessions/${id}/end`).set('x-fixture-identity','owner').send({...key(v.id),expectedVersion:1}).expect(201);
  }finally{await app.close();}
 });

});
