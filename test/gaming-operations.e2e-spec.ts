const dbUrl=process.env.TEST_DATABASE_URL??'';
const parsed=new URL(dbUrl);
if(!['localhost','127.0.0.1'].includes(parsed.hostname)||!/^\/matchena_gaming_test_[a-z0-9_]+$/.test(parsed.pathname))throw new Error('Dedicated local gaming database required');
process.env.DATABASE_URL=dbUrl;
import { randomUUID } from 'crypto';
import { PrismaService } from '../src/modules/prisma/prisma.service';
import { GamingCommandService } from '../src/modules/owner/gaming/gaming-command.service';
import { GamingSessionsService } from '../src/modules/owner/gaming/gaming-sessions.service';
import { GamingCommerceService } from '../src/modules/owner/gaming/gaming-commerce.service';
import { GamingReceiptsService } from '../src/modules/owner/gaming/gaming-receipts.service';
import { CommissionService } from '../src/modules/finance/commission.service';
import { LedgerService } from '../src/modules/finance/ledger.service';
import { CashService } from '../src/modules/owner/cash/cash.service';
import { OwnerBookingsService } from '../src/modules/owner/owner-bookings.service';
import { OwnerSummaryService } from '../src/modules/owner/owner-summary.service';
import { AuthenticatedUser } from '../src/common/types/authenticated-user.interface';
import { GamingOutboxService } from '../src/modules/owner/gaming/gaming-outbox.service';
import { NotificationsService } from '../src/modules/notifications/notifications.service';
jest.setTimeout(120000);
describe('gaming operational invariants on PostgreSQL',()=>{
 const db=new PrismaService();const commands=new GamingCommandService(db);const ledger=new LedgerService(db,new CommissionService(db,{} as never));const sessions=new GamingSessionsService(commands,ledger);const receipts=new GamingReceiptsService(commands,sessions);const commerce=new GamingCommerceService(commands,sessions,receipts);const cash=new CashService(db);
 let user:AuthenticatedUser;let venueId:string;let units:string[];let sportId:string;
 const key=()=>({venueId,requestKey:randomUUID()});
 const version=async(id:string)=> (await db.gamingOrder.findUniqueOrThrow({where:{id}})).version;
 async function booking(unitId:string,start:Date,end:Date,source:'manual'|'platform'='manual') {
   return db.booking.create({data:{code:randomUUID(),venueId,courtId:unitId,userId:user.id,slotStart:start,slotEnd:end,baseAmount:1000,totalAmount:1000,status:'confirmed',source}});
 }
 beforeAll(async()=>{
  await db.countryConfig.upsert({where:{code:'EG'},create:{code:'EG',nameAr:'مصر',nameEn:'Egypt',currency:'EGP',phoneCallingCode:'+20',timezone:'Africa/Cairo',weekendDays:[5,6],paymentMethods:['cash']},update:{}});
  const owner=await db.user.create({data:{name:'Operations fixture',phone:'+201099990002',roles:['owner']}});user={id:owner.id,name:owner.name,phone:owner.phone!,roles:['owner']};
  const sport=await db.sportCategory.create({data:{slug:'operations-fixture',nameAr:'ألعاب',nameEn:'Gaming',icon:'gamepad',accentColor:'#22cc88',activityKind:'gaming-station'}});sportId=sport.id;
  const venue=await db.venue.create({data:{slug:'operations-fixture',nameAr:'محل الاختبار',nameEn:'Test gaming',ownerId:user.id,lat:30,lng:31,geohash:'sv8',status:'active',approvedAt:new Date(),gamingSessionsEnabled:true,gamingProductsEnabled:true,gamingReceiptsEnabled:true}});venueId=venue.id;
  units=[];for(let i=0;i<12;i++){const unit=await db.court.create({data:{venueId,sportId,name:`PS5 ${i}`,pricingRules:{create:{label:'base',daysOfWeek:[],startTime:'00:00',endTime:'24:00',priceAmount:12000,currency:'EGP'}}}});units.push(unit.id);}
 });
 afterAll(()=>db.$disconnect());
 it('C01/C07 start ignores client Now and replay returns the original result',async()=>{
  const d={...key(),unitId:units[0],startMode:'now' as const,startsAt:'1900-01-01T00:00:00Z'};const before=Date.now();
  const s=await sessions.start(user,d);expect(Date.parse(s.startedAt as unknown as string)).toBeGreaterThanOrEqual(before);expect((await sessions.start(user,d)).id).toBe(s.id);
  await expect(sessions.start(user,{...d,durationMinutes:7})).rejects.toMatchObject({status:409});
 });
 it('C06/C09 every booking source and raw SQL write is excluded by a running open session',async()=>{
  for(const source of ['manual','platform'] as const) await expect(booking(units[0],new Date(Date.now()+3600000),new Date(Date.now()+7200000),source)).rejects.toThrow();
  const results=await Promise.allSettled(Array.from({length:8},()=>sessions.start(user,{...key(),unitId:units[1],startMode:'now'})));
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(await db.resourceOccupancy.count({where:{resourceId:units[1],running:true}})).toBe(1);
 });
 it('C06 owner/public/fixed/import/offline paths inherit the same database exclusion',async()=>{
  const start=new Date(Date.now()+86400000),end=new Date(start.getTime()+420000);
  const results=await Promise.allSettled(['owner','public','fixed','import','offline'].map(label=>db.booking.create({data:{code:randomUUID(),courtId:units[2],venueId,userId:user.id,slotStart:start,slotEnd:end,baseAmount:1000,totalAmount:1000,status:'confirmed',source:label==='public'?'platform':'manual',sourceLabel:label}})));
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
 });
 it('B07 exclusive parent blocks children and child blocks exclusive parent; independent peers remain available',async()=>{
  const room=await db.gamingRoom.create({data:{id:randomUUID(),venueId,name:'VIP',floorId:'ground',occupancy:'exclusive',bookableCourtId:units[3]}});
  await db.court.updateMany({where:{id:{in:[units[4],units[5]]}},data:{gamingRoomId:room.id}});
  const start=new Date(Date.now()+86400000),end=new Date(start.getTime()+600000);
  const child=await booking(units[4],start,end);await expect(booking(units[3],start,end)).rejects.toThrow();
  await db.booking.update({where:{id:child.id},data:{status:'cancelled'}});
  const parent=await booking(units[3],start,end);await expect(booking(units[5],start,end)).rejects.toThrow();
  await db.booking.update({where:{id:parent.id},data:{status:'cancelled'}});
  await db.gamingRoom.update({where:{id:room.id},data:{occupancy:'independent',bookableCourtId:null}});
  await Promise.all([booking(units[4],start,end),booking(units[5],start,end)]);
 });
 it('C08 failed extend/transfer preserves segments and source occupancy',async()=>{
  const s=await sessions.start(user,{...key(),unitId:units[6],startMode:'now',durationMinutes:1});
  const start=new Date(Date.now()+120000);await booking(units[6],start,new Date(start.getTime()+60000));
  await expect(sessions.extend(user,s.id,{...key(),expectedVersion:1,additionalMinutes:5})).rejects.toMatchObject({status:409});
  await expect(sessions.transfer(user,s.id,{...key(),expectedVersion:1,targetUnitId:units[0]})).rejects.toMatchObject({status:409});
  expect((await db.usageSession.findUniqueOrThrow({where:{id:s.id}})).version).toBe(1);expect(await db.usageSegment.count({where:{sessionId:s.id,endedAt:null}})).toBe(1);
 });
 it('C05 snapshots remain fixed after price changes; transfer uses destination price; end frees an unpaid unit',async()=>{
  const s=await sessions.start(user,{...key(),unitId:units[7],startMode:'now'});
  await db.pricingRule.updateMany({where:{courtId:units[7]},data:{priceAmount:99999}});
  expect((await db.usageSegment.findFirstOrThrow({where:{sessionId:s.id}})).hourlyRateMinor).toBe(12000);
  const moved=await sessions.transfer(user,s.id,{...key(),expectedVersion:1,targetUnitId:units[8]});expect(moved.version).toBe(2);
  const segments=await db.usageSegment.findMany({where:{sessionId:s.id},orderBy:{startedAt:'asc'}});expect(segments[0].endedAt!.getTime()).toBe(segments[1].startedAt.getTime());
  const d={...key(),expectedVersion:2};const ended=await sessions.end(user,s.id,d);expect((await sessions.end(user,s.id,d)).id).toBe(ended.id);
  expect(await db.resourceOccupancy.count({where:{sessionId:s.id}})).toBe(0);expect((await db.gamingOrder.findUniqueOrThrow({where:{id:s.orderId}})).state).toBe('open');
 });
 it('C05 booking check-in links its existing payment once and does not create another time charge',async()=>{
  const b=await booking(units[9],new Date(Date.now()-10000),new Date(Date.now()+300000));
  const payment=await db.payment.create({data:{bookingId:b.id,amount:1000,currency:'EGP',method:'cash',status:'paid',recordedByUserId:user.id}});
  const s=await sessions.start(user,{...key(),unitId:units[9],bookingId:b.id,startMode:'now'});
  const order=await commerce.detail(user,s.orderId);expect(order.totalMinor).toBe(1000);expect(order.receivedMinor).toBe(1000);
  expect(await db.payment.count({where:{bookingId:b.id}})).toBe(1);expect((await db.payment.findUniqueOrThrow({where:{id:payment.id}})).gamingOrderId).toBe(s.orderId);
  await sessions.end(user,s.id,{...key(),expectedVersion:1});
 });
 it('D01/D02/D04 concurrent last-item sales and immutable price snapshots',async()=>{
  const p=await commerce.product(user,{...key(),nameAr:'مياه',nameEn:'Water',category:'drinks',priceMinor:1500,stockTracked:true});
  const stock=await commerce.stock(user,p.id,{...key(),expectedVersion:1,delta:1,reason:'receive'});
  const a=await commerce.create(user,key()),b=await commerce.create(user,key());
  const results=await Promise.allSettled([a,b].map(o=>commerce.add(user,o.id,{...key(),expectedVersion:1,productId:p.id,quantity:1})));
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect((await db.gamingProduct.findUniqueOrThrow({where:{id:p.id}})).availableQuantity).toBe(0);
  const line=await db.gamingOrderLine.findFirstOrThrow({where:{sourceId:p.id}});
  await commerce.product(user,{...key(),expectedVersion:3,nameAr:'مياه جديدة',nameEn:'New water',category:'drinks',priceMinor:2500,stockTracked:true,active:false},p.id);
  expect((await db.gamingOrderLine.findUniqueOrThrow({where:{id:line.id}})).unitPriceMinor).toBe(1500);
  const d={...key(),expectedVersion:await version(line.orderId),quantity:1,restock:true,reason:'return'};await commerce.returnLine(user,line.orderId,line.id,d);await commerce.returnLine(user,line.orderId,line.id,d);
  expect((await db.gamingProduct.findUniqueOrThrow({where:{id:p.id}})).availableQuantity).toBe(1);
 });
 it('D03/D05/E01/E02 partial collect retries reconcile with cash, immutable receipts and reprints',async()=>{
  const p=await commerce.product(user,{...key(),nameAr:'شاي',nameEn:'Tea',category:'drinks',priceMinor:2000,stockTracked:false});
  const o=await commerce.create(user,key());await commerce.add(user,o.id,{...key(),expectedVersion:1,productId:p.id,quantity:2});
  const d={...key(),expectedVersion:await version(o.id),amountMinor:1500,method:'cash' as const};const result=await commerce.collect(user,o.id,d);expect((await commerce.collect(user,o.id,d)).paymentId).toBe(result.paymentId);
  const original=await receipts.read(user,result.receiptId);await db.venue.update({where:{id:venueId},data:{nameAr:'اسم تغير'}});expect((await receipts.read(user,result.receiptId)).snapshot).toEqual(original.snapshot);
  await expect(db.receiptDocument.update({where:{id:original.id},data:{kind:'tampered'}})).rejects.toThrow();
  const job=await receipts.job(user,original.id,{...key(),terminalId:randomUUID()});await receipts.status(user,job.id,{...key(),status:'unknown'});
  expect(await db.payment.count({where:{gamingOrderId:o.id}})).toBe(1);expect((await commerce.detail(user,o.id)).remainingMinor).toBe(2500);
  const allocations=await db.gamingPaymentAllocation.findMany({where:{paymentId:result.paymentId}});expect(allocations.reduce((sum,a)=>sum+a.amountMinor,0)).toBe(1500);
  const book=await new OwnerSummaryService(db).cashbook(venueId,new Date(Date.now()-86400000),new Date(Date.now()+86400000));expect(book.received).toBeGreaterThanOrEqual(1500);
  const drawer=await cash.drawer(user,venueId);expect((drawer.mine as any).cash.in).toBeGreaterThanOrEqual(1500);
  const refund=await commerce.refund(user,o.id,{...key(),expectedVersion:await version(o.id),paymentId:result.paymentId,reason:'customer requested'});expect((await receipts.read(user,refund.receiptId)).kind).toBe('refund');expect((await commerce.detail(user,o.id)).receivedMinor).toBe(0);
 });
 it('D03 multiple sessions share one order, allocations sum exactly, settle requires ended sessions and full payment',async()=>{
  const s=await sessions.start(user,{...key(),unitId:units[10],startMode:'now'});
  const second=await sessions.start(user,{...key(),unitId:units[11],startMode:'now',orderId:s.orderId,orderVersion:await version(s.orderId)});expect(second.orderId).toBe(s.orderId);
  await expect(commerce.settle(user,s.orderId,{...key(),expectedVersion:await version(s.orderId)})).rejects.toMatchObject({status:409});
  await sessions.end(user,s.id,{...key(),expectedVersion:1});await sessions.end(user,second.id,{...key(),expectedVersion:1});
  const order=await commerce.detail(user,s.orderId);
  if(order.totalMinor) await commerce.collect(user,s.orderId,{...key(),expectedVersion:order.version,amountMinor:order.totalMinor,method:'cash'});
  expect((await commerce.settle(user,s.orderId,{...key(),expectedVersion:await version(s.orderId)})).order.state).toBe('settled');
 });
 it('A01/A03 denies suspended commands and cross-tenant receipt/order/product scope',async()=>{
  const foreign={...user,id:randomUUID()};await expect(sessions.board(foreign,venueId)).rejects.toMatchObject({status:403});
  const o=await commerce.create(user,key());await expect(commerce.detail(foreign,o.id)).rejects.toMatchObject({status:403});
  await db.venue.update({where:{id:venueId},data:{status:'suspended'}});await expect(commerce.create(user,key())).rejects.toMatchObject({status:403});await db.venue.update({where:{id:venueId},data:{status:'active'}});
 });
 it('A01/A04 approval states and permission revocation block even an idempotent retry',async()=>{
  const d=key();for(const state of ['pending','suspended'] as const){await db.venue.update({where:{id:venueId},data:{status:state}});await expect(commerce.product(user,{...key(),nameAr:'ممنوع',nameEn:'Denied',category:'food',priceMinor:100,stockTracked:false})).rejects.toMatchObject({status:403});await expect(sessions.start(user,{...key(),unitId:units[9],startMode:'now'})).rejects.toMatchObject({status:403});}await db.venue.update({where:{id:venueId},data:{status:'active'}});
  const rejected=await db.partnerApplication.create({data:{ownerId:user.id,venueId,status:'rejected',payload:{},publicNameAr:'مرفوض',publicNameEn:'Rejected',contactPhone:'+201099990015'}});await expect(commerce.create(user,key())).rejects.toMatchObject({status:403});await db.partnerApplication.update({where:{id:rejected.id},data:{status:'approved'}});
  const employee=await db.user.create({data:{name:'Revoked cashier',phone:'+201099990015',roles:['staff']}});await db.staffMember.create({data:{userId:employee.id,ownerId:user.id,createdById:user.id,venueIds:[venueId],permissions:['orders.manage']}});const cashier={...employee,roles:['staff']} as AuthenticatedUser;
  await commerce.create(cashier,d);await db.staffMember.updateMany({where:{userId:employee.id},data:{permissions:[]}});await expect(commerce.create(cashier,d)).rejects.toMatchObject({status:403});
 });
 it('D03/D06 mixed booking and product collection reaches each existing financial source once',async()=>{
  const unit=await db.court.create({data:{venueId,sportId,name:'Mixed collection',pricingRules:{create:{label:'base',startTime:'00:00',endTime:'24:00',daysOfWeek:[],priceAmount:12000,currency:'EGP'}}}});
  const b=await booking(unit.id,new Date(Date.now()-1000),new Date(Date.now()+600000));
  const s=await sessions.start(user,{...key(),unitId:unit.id,bookingId:b.id,startMode:'now'});
  const p=await commerce.product(user,{...key(),nameAr:'منتج',nameEn:'Product',category:'drinks',priceMinor:2000,stockTracked:false});
  await commerce.add(user,s.orderId,{...key(),expectedVersion:await version(s.orderId),productId:p.id,quantity:1});
  const d={...key(),expectedVersion:await version(s.orderId),amountMinor:1500,method:'cash' as const};
  const summaryService=new OwnerSummaryService(db);const before=await summaryService.getSummary(user,venueId);const cashBefore=await summaryService.cashbook(venueId,new Date(0),new Date(Date.now()+86400000));
  const result=await commerce.collect(user,s.orderId,d);await commerce.collect(user,s.orderId,d);
  const after=await summaryService.getSummary(user,venueId);expect(after.totals.ownRevenue-before.totals.ownRevenue).toBe(1500);expect(after.totals.commission-before.totals.commission).toBe(0);
  const cashAfter=await summaryService.cashbook(venueId,new Date(0),new Date(Date.now()+86400000));expect(cashAfter.received-cashBefore.received).toBe(1500);expect(cashAfter.byMethod.find(x=>x.method==='cash')!.count-cashBefore.byMethod.find(x=>x.method==='cash')!.count).toBe(1);
  const bookings=new OwnerBookingsService(db,ledger,new CommissionService(db,{} as never),{} as never);
  const projected=await bookings.toOwnerBookingDto(await db.booking.findUniqueOrThrow({where:{id:b.id}}),user);expect(projected.money.paidAmount).toBe(500);expect(projected.money.outstanding).toBe(500);expect(projected.gamingOrderId).toBe(s.orderId);expect(projected.canEdit).toBe(false);expect(projected.payments).toHaveLength(1);
  const paid=await db.payment.findMany({where:{gamingOrderId:s.orderId}});
  expect(paid.reduce((sum,p)=>sum+p.amount,0)).toBe(1500);
  expect(paid).toHaveLength(1);expect((await db.gamingPaymentAllocation.findMany({where:{paymentId:paid[0].id,line:{kind:'booking-time'}}})).reduce((n,a)=>n+a.amountMinor,0)).toBe(500);
  expect((await db.booking.findUniqueOrThrow({where:{id:b.id}})).paymentStatus).toBe('partial');
  expect((await new OwnerSummaryService(db).gamingIncome(venueId,new Date(0),new Date(Date.now()+1000))).products).toBeGreaterThanOrEqual(1000);
  await expect(db.payment.create({data:{bookingId:b.id,amount:1,currency:'EGP',method:'cash',status:'paid'}})).rejects.toThrow();
  await expect(db.booking.update({where:{id:b.id},data:{status:'cancelled'}})).rejects.toThrow();
  expect((await receipts.read(user,result.receiptId)).snapshot).toMatchObject({payment:{amountMinor:1500}});
  await commerce.refund(user,s.orderId,{...key(),expectedVersion:await version(s.orderId),paymentId:result.paymentId,amountMinor:300,reason:'Mixed partial refund'});
  const refunded=await bookings.toOwnerBookingDto(await db.booking.findUniqueOrThrow({where:{id:b.id}}),user);expect(refunded.money.paidAmount).toBe(400);expect(refunded.money.outstanding).toBe(600);
  const afterRefund=await summaryService.getSummary(user,venueId);expect(afterRefund.totals.ownRevenue-before.totals.ownRevenue).toBe(1200);
 });
 it('D03/C07 concurrent collections and partial refunds cannot exceed the original amount',async()=>{
  const p=await commerce.product(user,{...key(),nameAr:'حلوى',nameEn:'Snack',category:'food',priceMinor:1000,stockTracked:false});
  const o=await commerce.create(user,key());await commerce.add(user,o.id,{...key(),expectedVersion:1,productId:p.id,quantity:1});
  const v=await version(o.id);const results=await Promise.allSettled(Array.from({length:6},()=>commerce.collect(user,o.id,{...key(),expectedVersion:v,amountMinor:1000,method:'cash'})));
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  const payment=await db.payment.findFirstOrThrow({where:{gamingOrderId:o.id,amount:{gt:0}}});
  const d={...key(),expectedVersion:await version(o.id),paymentId:payment.id,amountMinor:300,reason:'partial'};
  await commerce.refund(user,o.id,d);await commerce.refund(user,o.id,d);
  await expect(commerce.refund(user,o.id,{...key(),expectedVersion:await version(o.id),paymentId:payment.id,amountMinor:701,reason:'too much'})).rejects.toMatchObject({status:400});
  await commerce.refund(user,o.id,{...key(),expectedVersion:await version(o.id),paymentId:payment.id,amountMinor:700,reason:'remainder'});
  expect((await commerce.detail(user,o.id)).receivedMinor).toBe(0);
 });
 it('C09 fixed overruns remain occupied; deferred database checks reject unallocated money and segment gaps',async()=>{
  const unit=await db.court.create({data:{venueId,sportId,name:'Overrun',pricingRules:{create:{label:'base',startTime:'00:00',endTime:'24:00',daysOfWeek:[],priceAmount:12000,currency:'EGP'}}}});
  const s=await sessions.start(user,{...key(),unitId:unit.id,startMode:'now',durationMinutes:1});
  await db.usageSession.update({where:{id:s.id},data:{expectedEnd:new Date(Date.parse(s.startedAt as unknown as string)+1)}});
  await expect(booking(unit.id,new Date(Date.now()+86400000),new Date(Date.now()+86460000))).rejects.toThrow();
  await expect(db.payment.create({data:{gamingOrderId:s.orderId,amount:100,currency:'EGP',method:'cash',status:'paid'}})).rejects.toThrow();
  await expect(db.usageSegment.updateMany({where:{sessionId:s.id},data:{startedAt:new Date(Date.now()+1000)}})).rejects.toThrow();
  await sessions.end(user,s.id,{...key(),expectedVersion:1});
  await expect(booking(unit.id,new Date(Date.now()+86400000),new Date(Date.now()+86460000))).resolves.toHaveProperty('id');
 });
 it('B03 duplicated business units have fresh identities and no inherited accounts or bookings',async()=>{
  const d={...key(),sourceUnitIds:[units[0],units[2]]};const result=await sessions.duplicateUnits(user,d);expect(await sessions.duplicateUnits(user,d)).toEqual(result);
  for(const [source,id] of Object.entries(result.mapping)){
   expect(id).not.toBe(source);expect((await db.court.findUniqueOrThrow({where:{id}})).gamingPublished).toBe(false);
   expect(await db.booking.count({where:{courtId:id}})).toBe(0);expect(await db.usageSession.count({where:{unitId:id}})).toBe(0);
  }
 });
 it('C04/D05 three-decimal cash reconciles alongside unchanged legacy hundredths',async()=>{
  await db.countryConfig.upsert({where:{code:'KW'},create:{code:'KW',nameAr:'الكويت',nameEn:'Kuwait',currency:'KWD',phoneCallingCode:'+965',timezone:'Asia/Kuwait',weekendDays:[5,6],paymentMethods:['cash']},update:{}});
  const venue=await db.venue.create({data:{slug:'kw-gaming-fixture',nameAr:'الكويت',nameEn:'Kuwait',countryCode:'KW',currency:'KWD',ownerId:user.id,lat:30,lng:31,geohash:'sv8',status:'active',approvedAt:new Date(),gamingSessionsEnabled:true,gamingProductsEnabled:true,gamingReceiptsEnabled:true}});
  const request=()=>({venueId:venue.id,requestKey:randomUUID()});const unit=await db.court.create({data:{venueId:venue.id,sportId,name:'KWD station',pricingRules:{create:{label:'base',startTime:'00:00',endTime:'24:00',daysOfWeek:[],priceAmount:120,currency:'KWD'}}}});
  const old=await db.booking.create({data:{code:randomUUID(),venueId:venue.id,courtId:unit.id,userId:user.id,slotStart:new Date(Date.now()-600000),slotEnd:new Date(Date.now()-300000),baseAmount:100,totalAmount:100,currency:'KWD',status:'completed',source:'manual',paymentStatus:'paid'}});
  await db.payment.create({data:{bookingId:old.id,amount:100,currency:'KWD',method:'cash',status:'paid',recordedByUserId:user.id}});
  const session=await sessions.start(user,{...request(),unitId:unit.id,startMode:'manual',startsAt:new Date(Date.now()-45000).toISOString()});await sessions.end(user,session.id,{...request(),expectedVersion:1});expect((await db.usageSegment.findFirstOrThrow({where:{sessionId:session.id}})).hourlyRateMinor).toBe(1200);
  const product=await commerce.product(user,{...request(),nameAr:'منتج',nameEn:'Product',category:'food',priceMinor:125,stockTracked:false});await commerce.add(user,session.orderId,{...request(),expectedVersion:await version(session.orderId),productId:product.id,quantity:1});
  const order=await commerce.detail(user,session.orderId);expect(order.totalMinor).toBe(140);const result=await commerce.collect(user,order.id,{...request(),expectedVersion:order.version,amountMinor:140,method:'cash'});
  expect((await receipts.read(user,result.receiptId)).snapshot).toMatchObject({currency:'KWD',payment:{amountMinor:140}});
  const drawer=await cash.drawer(user,venue.id);expect((drawer.mine as any).cash.in).toBeCloseTo(114,6);
  const summary=await new OwnerSummaryService(db).getSummary(user,venue.id);expect(summary.totals.ownRevenue).toBeCloseTo(114,6);expect(summary.gaming.productRevenue).toBe(12.5);
  const shift=await cash.closeShift(user,{venueId:venue.id,scope:'mine',countedCash:114,carryOver:.1});expect(shift.difference).toBe(0);expect(shift.carryOver).toBe(.1);const saved=await db.cashShift.findUniqueOrThrow({where:{id:shift.id}});expect(saved.moneyScale).toBe(1000);expect(saved.cashIn).toBe(1140);expect(saved.carryOver).toBe(1);
  await cash.openShift(user,{venueId:venue.id,scope:'mine',countedFloat:.1});const next=await cash.closeShift(user,{venueId:venue.id,scope:'mine',countedCash:.1,carryOver:.1});expect(next.difference).toBe(0);
  await commerce.refund(user,order.id,{...request(),expectedVersion:await version(order.id),paymentId:result.paymentId,amountMinor:1,reason:'one fils'});expect((await commerce.detail(user,order.id)).receivedMinor).toBe(139);expect(((await cash.drawer(user,venue.id)).mine as any).cash.refunds).toBe(.1);
 });
 it('D07 shared contact keeps distinct guest snapshots and a stable profile',async()=>{
  const profile=await db.venueCustomer.create({data:{venueId,key:'phone:+201099990025',phone:'+201099990025',name:'Original profile'}});const first=await commerce.create(user,{...key(),customerId:profile.id,guestName:'First guest',guestPhone:'01099990025'});const second=await commerce.create(user,{...key(),guestName:'Second guest',guestPhone:'01099990025'});expect(first.id).not.toBe(second.id);expect(first.customerId).toBe(profile.id);expect(second.customerId).toBeNull();expect((await db.venueCustomer.findUniqueOrThrow({where:{id:profile.id}})).name).toBe('Original profile');expect(first.guestName).toBe('First guest');expect(second.guestName).toBe('Second guest');
 });
 it('A04 mutation and idempotent replay redact current financial/customer permissions',async()=>{
  const employee=await db.user.create({data:{name:'Orders only',phone:'+201099990030',roles:['staff']}});
  await db.staffMember.create({data:{userId:employee.id,ownerId:user.id,createdById:user.id,venueIds:[venueId],permissions:['orders.manage','customers.view']}});
  const actor={...employee,roles:['staff']} as AuthenticatedUser,d={...key(),guestName:'Private guest',guestPhone:'01099990031'};
  const created=await commerce.create(actor,d);expect(created).not.toHaveProperty('totalMinor');expect(created.guestName).toBe('Private guest');
  await db.staffMember.updateMany({where:{userId:employee.id},data:{permissions:['orders.manage']}});
  const replay=await commerce.create(actor,d);expect(replay.id).toBe(created.id);expect(replay).not.toHaveProperty('guestName');expect(replay).not.toHaveProperty('guestPhone');
  const product=await commerce.product(user,{...key(),nameAr:'اختبار',nameEn:'Test',category:'food',priceMinor:100,stockTracked:false});
  const added=await commerce.add(actor,created.id,{...key(),expectedVersion:1,productId:product.id,quantity:1});expect(added).not.toHaveProperty('totalMinor');expect(added).not.toHaveProperty('lines');expect((await commerce.detail(user,created.id)).totalMinor).toBe(100);
 });
 it('D06 database rejects allocation checksums that would pass truncated scale division',async()=>{
  const order=await commerce.create(user,key());
  await expect(db.payment.create({data:{gamingOrderId:order.id,amount:1,moneyScale:1000,currency:'EGP',method:'cash',status:'paid'}})).rejects.toThrow();
 });
 it('C05 precise creation tariffs yield to later pricing edits without rewriting snapshots',async()=>{
  const created=await sessions.createUnits(user,{...key(),assetKey:'ps5',count:1,namePrefix:'Precise tariff',hourlyRateMinor:1234});
  const unit=created.units[0];await db.court.update({where:{id:unit.id},data:{gamingPublished:true}});
  const first=await sessions.start(user,{...key(),unitId:unit.id,startMode:'now'});expect((await db.usageSegment.findFirstOrThrow({where:{sessionId:first.id}})).hourlyRateMinor).toBe(1234);
  await sessions.end(user,first.id,{...key(),expectedVersion:1});await db.pricingRule.updateMany({where:{courtId:unit.id},data:{priceAmount:2000}});
  expect((await db.court.findUniqueOrThrow({where:{id:unit.id}})).gamingHourlyRateMinor).toBeNull();const next=await sessions.start(user,{...key(),unitId:unit.id,startMode:'now'});
  expect((await db.usageSegment.findFirstOrThrow({where:{sessionId:next.id}})).hourlyRateMinor).toBe(2000);expect((await db.usageSegment.findFirstOrThrow({where:{sessionId:first.id}})).hourlyRateMinor).toBe(1234);
 });
 it('E01/E02 optional sports receipts reuse the original booking and payment without gaming activation',async()=>{
  const sport=await db.sportCategory.create({data:{slug:'receipt-sport-fixture',nameAr:'ملعب',nameEn:'Field',icon:'football',accentColor:'#22cc88',activityKind:'field-sport'}});const venue=await db.venue.create({data:{slug:'sports-receipt-fixture',nameAr:'ملعب الإيصال',nameEn:'Receipt field',ownerId:user.id,lat:30,lng:31,geohash:'sv8',status:'active',approvedAt:new Date()}});const unit=await db.court.create({data:{venueId:venue.id,sportId:sport.id,name:'Football'}});const request=()=>({venueId:venue.id,requestKey:randomUUID()});
  const b=await db.booking.create({data:{code:randomUUID(),venueId:venue.id,courtId:unit.id,userId:user.id,slotStart:new Date(Date.now()-60000),slotEnd:new Date(Date.now()+3600000),baseAmount:1000,totalAmount:1000,status:'confirmed',source:'manual'}});const payment=await db.payment.create({data:{bookingId:b.id,amount:300,currency:'EGP',method:'cash',status:'paid',recordedByUserId:user.id}});
  await expect(receipts.booking(user,b.id,request())).rejects.toMatchObject({status:403});await receipts.configure(user,{...request(),enabled:true,expectedVersion:1,widthMm:58,language:'bilingual',header:'',footer:'',copies:1,autoPrint:false});const d={...request(),paymentId:payment.id};const doc=await receipts.booking(user,b.id,d);expect((await receipts.booking(user,b.id,d)).id).toBe(doc.id);expect(doc.orderId).toBeNull();expect(doc.bookingId).toBe(b.id);expect(doc.snapshot).toMatchObject({payment:{amountMinor:300},remainingMinor:700});expect(await db.payment.count({where:{bookingId:b.id}})).toBe(1);expect(await db.gamingOrder.count({where:{venueId:venue.id}})).toBe(0);
 });
 it('F07/F05 outbox retries after commit, scopes invalidations, and deduplicates reminders without external transports',async()=>{
  const allowed=await db.user.create({data:{name:'Allowed staff',phone:'+201099990003',roles:['staff']}}),denied=await db.user.create({data:{name:'Other venue staff',phone:'+201099990004',roles:['staff']}});
  await db.staffMember.create({data:{ownerId:user.id,userId:allowed.id,createdById:user.id,permissions:['bookings.view','sessions.end'],venueIds:[venueId]}});
  await db.staffMember.create({data:{ownerId:user.id,userId:denied.id,createdById:user.id,permissions:['bookings.view','sessions.end'],venueIds:[]}});
  await db.gamingOutbox.updateMany({where:{venueId},data:{deliveredAt:new Date()}});
  const event=await db.gamingOutbox.create({data:{venueId,entityId:venueId,version:999,type:'layout.published'}});
  let failed=false;const emitter={emitToUser:jest.fn().mockImplementation((_id,payload)=>{if(payload.eventId===event.id&&!failed){failed=true;throw new Error('transport unavailable');}}),emitToRoom:jest.fn(),disconnectUser:jest.fn(),revokeRoomAccess:jest.fn()};
  const transport={sendToUser:jest.fn().mockResolvedValue(undefined),send:jest.fn().mockResolvedValue(undefined)};
  const notifications=new NotificationsService(db,emitter,{} as never,transport as never,transport as never);
  const worker=new GamingOutboxService(db,emitter,notifications);
  await worker.drain();expect((await db.gamingOutbox.findUniqueOrThrow({where:{id:event.id}})).deliveredAt).toBeNull();
  await worker.drain();await worker.drain();expect((await db.gamingOutbox.findUniqueOrThrow({where:{id:event.id}})).attempts).toBe(2);
  const invalidations=emitter.emitToUser.mock.calls.filter(c=>c[1].type==='layout.published');expect(invalidations.some(c=>c[0]===allowed.id)).toBe(true);expect(invalidations.some(c=>c[0]===denied.id)).toBe(false);
  expect(invalidations.every(c=>!JSON.stringify(c[1]).includes('guestPhone'))).toBe(true);
  expect(await db.notification.count({where:{dedupKey:`gaming-layout:${event.id}`}})).toBe(1);
  await worker.reminders();const before=await db.notification.count({where:{dedupKey:{startsWith:'gaming-reminder:'}}});await worker.reminders();expect(await db.notification.count({where:{dedupKey:{startsWith:'gaming-reminder:'}}})).toBe(before);
  await db.staffMember.update({where:{userId:allowed.id},data:{permissions:[]}});
  emitter.emitToUser.mockClear();await db.gamingOutbox.create({data:{venueId,entityId:venueId,version:1000,type:'order.updated'}});await worker.drain();expect(emitter.emitToUser.mock.calls.some(c=>c[0]===allowed.id)).toBe(false);
 });
});
