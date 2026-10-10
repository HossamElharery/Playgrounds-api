import { gamingConfigObject, selectGamingTariff, type PlayMode } from './gaming-tariff';
import { isoMoneyScale,rescaleMoney } from '../../../common/money/money-scale';
import { guestPhoneForStorage } from '../../../common/utils/guest-phone.util';
import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { Court, Prisma, UsageSegment, UsageSession } from '@prisma/client';
import { AuthenticatedUser } from '../../../common/types/authenticated-user.interface';
import { coveringPricingRule } from '../../../common/utils/pricing-rule.util';
import { zonedWeekday } from '../../../common/utils/timezone.util';
import { assertStaffPermission } from '../../../common/access/owner-access';
import { loadStaffScope, scopeCan } from '../../../common/access/staff-scope';
import { LedgerService } from '../../finance/ledger.service';
import { GamingCommandService, jsonValue } from './gaming-command.service';
import { ChangePlayModeDto, UnitTariffDto, BillingSettingsDto, CorrectSessionEndDto, CreateGamingUnitsDto, DuplicateGamingUnitsDto, ExtendSessionDto, GamingCapabilitiesDto, GamingMaintenanceDto, GamingCommandDto, GamingVersionDto, ReasonCommandDto, StartSessionDto, TransferSessionDto } from './gaming-operations.dto';
import { allocatePayment, calculateSessionCharge, calculateUsageCharge, SessionBillingPolicy } from './session-billing';
const exact: SessionBillingPolicy = { version: 1, mode: 'exact-time' };
@Injectable()
export class GamingSessionsService {
  constructor(private readonly commands: GamingCommandService, private readonly ledger: LedgerService) {}
  private get prisma() { return this.commands.prisma; }
  async capabilities(user: AuthenticatedUser, venueId: string) {
    const venue = await this.commands.access(this.prisma,user,venueId,'bookings.view',false);
    return { venueId, approved: venue.status==='active' && !!venue.approvedAt, sessionsEnabled: venue.gamingSessionsEnabled, productsEnabled: venue.gamingProductsEnabled, receiptsEnabled: venue.gamingReceiptsEnabled, billingPolicy: venue.gamingBillingPolicy ?? exact, serverNow: new Date().toISOString() };
  }
  configure(user: AuthenticatedUser, dto: GamingCapabilitiesDto) {
    return this.commands.command(user,'venue.manage','capabilities',dto, async tx => {
      await tx.venue.update({where:{id:dto.venueId},data:{gamingSessionsEnabled:dto.sessionsEnabled,gamingProductsEnabled:dto.productsEnabled,gamingReceiptsEnabled:dto.receiptsEnabled}});
      return {sessionsEnabled:dto.sessionsEnabled,productsEnabled:dto.productsEnabled,receiptsEnabled:dto.receiptsEnabled};
    });
  }
  billing(user: AuthenticatedUser, dto: BillingSettingsDto) {
    return this.commands.command(user,'pricing.manage','billing-policy',dto, async tx => {
      const policy = {version:1,mode:dto.mode,minimumMinutes:dto.minimumMinutes,stepMinutes:dto.stepMinutes};
      await tx.venue.update({where:{id:dto.venueId},data:{gamingBillingPolicy:policy}}); return policy;
    });
  }
  createUnits(user:AuthenticatedUser,dto:CreateGamingUnitsDto) {
    return this.commands.command(user,'venue.manage','units.create',dto,async tx=>{
      if(dto.multiHourlyRateMinor!==undefined)selectGamingTariff({consoleType:dto.assetKey,multiHourlyRateMinor:dto.multiHourlyRateMinor},dto.hourlyRateMinor,'multi');
      const table=['billiards','table-tennis'].includes(dto.assetKey);
      const sport=await tx.sportCategory.findFirst({where:table?{slug:dto.assetKey,activityKind:'table-game'}:{activityKind:'gaming-station'}});
      if(!sport)throw new BadRequestException({code:'ACTIVITY_NOT_CONFIGURED'});
      if(!dto.namePrefix.trim())throw new BadRequestException({code:'UNIT_NAME_REQUIRED'});
      const venue=await tx.venue.findUniqueOrThrow({where:{id:dto.venueId}});
      const offset=await tx.court.count({where:{venueId:dto.venueId,sportId:sport.id}});
      const units: Court[]=[];
      for(let i=0;i<dto.count;i++)units.push(await tx.court.create({data:{venueId:dto.venueId,sportId:sport.id,name:`${dto.namePrefix.trim()} ${offset+i+1}`,gamingPublished:false,gamingHourlyRateMinor:dto.hourlyRateMinor,slotDurationMins:60,...(table?{tableConfig:{tableType:dto.assetKey,rentalAvailable:false}}:{gamingConfig:{consoleType:dto.assetKey,seats:dto.multiHourlyRateMinor?4:2,roomTier:'standard',...(dto.multiHourlyRateMinor!==undefined?{multiHourlyRateMinor:dto.multiHourlyRateMinor}:{})}}),pricingRules:{create:{label:'base',daysOfWeek:[],startTime:'00:00',endTime:'24:00',priceAmount:Math.round(rescaleMoney(dto.hourlyRateMinor,isoMoneyScale(venue.currency),100)),currency:venue.currency}}}}));
      return {units};
    });
  }
  private async rate(tx: Prisma.TransactionClient, venueId: string, unitId: string, now: Date, playMode: PlayMode = 'standard') {
    const unit = await tx.court.findFirst({where:{id:unitId,venueId},include:{sport:true,pricingRules:true,venue:{include:{country:true}}}});
    if (!unit || !unit.gamingPublished || !['gaming-station','table-game'].includes(unit.sport.activityKind ?? '')) throw new BadRequestException({code:'INVALID_GAMING_UNIT'});
    const rule = coveringPricingRule(unit.pricingRules,zonedWeekday(now,unit.venue.country.timezone),now,unit.venue.country.timezone);
    if (!rule || rule.currency !== unit.venue.currency) throw new BadRequestException({code:'PRICING_REQUIRED'});
    return {unit,rule:{...rule,priceAmount:selectGamingTariff(unit.gamingConfig,unit.gamingHourlyRateMinor??rescaleMoney(rule.priceAmount,100,isoMoneyScale(unit.venue.currency)),playMode)}};
  }
  duplicateUnits(user:AuthenticatedUser,dto:DuplicateGamingUnitsDto){
    return this.commands.command(user,'venue.manage','units.duplicate',dto,async tx=>{
      const mapping:Record<string,string>={};
      for(const id of [...new Set(dto.sourceUnitIds)].sort()){
        const source=await tx.court.findFirst({where:{id,venueId:dto.venueId},include:{sport:true,pricingRules:true}});
        if(!source||!['gaming-station','table-game'].includes(source.sport.activityKind??''))throw new ForbiddenException({code:'INVALID_GAMING_UNIT'});
        const copy=await tx.court.create({data:{venueId:source.venueId,sportId:source.sportId,name:`${source.name} · copy`,slotDurationMins:source.slotDurationMins,gamingPublished:false,gamingHourlyRateMinor:source.gamingHourlyRateMinor,gamingConfig:source.gamingConfig??Prisma.JsonNull,tableConfig:source.tableConfig??Prisma.JsonNull,pricingRules:{create:source.pricingRules.map(r=>({label:r.label,daysOfWeek:r.daysOfWeek,startTime:r.startTime,endTime:r.endTime,priceAmount:r.priceAmount,currency:r.currency}))}}});
        mapping[id]=copy.id;
      }return {mapping};
    });
  }
  maintenance(user:AuthenticatedUser,dto:GamingMaintenanceDto){
    return this.commands.command(user,'schedule.manage','unit.maintenance',dto,async(tx,now)=>{
      if(!dto.reason.trim())throw new BadRequestException({code:'REASON_REQUIRED'});
      if(!await tx.court.findFirst({where:{id:dto.unitId,venueId:dto.venueId}}))throw new ForbiddenException({code:'INVALID_GAMING_UNIT'});
      const block=await tx.calendarBlock.create({data:{venueId:dto.venueId,courtId:dto.unitId,kind:'maintenance',note:dto.reason,startsAt:now,endsAt:new Date(now.getTime()+dto.durationMinutes*60000),createdById:user.id}});
      await this.commands.event(tx,dto.venueId,dto.unitId,null,'session.changed');return block;
    });
  }
  reopen(user:AuthenticatedUser,id:string,dto:GamingCommandDto){
    return this.commands.command(user,'schedule.manage',`unit.reopen:${id}`,dto,async tx=>{
      const block=await tx.calendarBlock.findFirst({where:{id,venueId:dto.venueId,kind:'maintenance'}});
      if(!block)throw new ForbiddenException({code:'BLOCK_NOT_ACCESSIBLE'});
      await tx.calendarBlock.delete({where:{id}});await this.commands.event(tx,dto.venueId,block.courtId??dto.venueId,null,'session.changed');return {id};
    });
  }
  start(user: AuthenticatedUser, dto: StartSessionDto) {
    return this.commands.command(user,'sessions.start','session.start',dto,async (tx,now) => {
      const venue = await tx.venue.findUniqueOrThrow({where:{id:dto.venueId}});
      if (!venue.gamingSessionsEnabled) throw new ForbiddenException({code:'SESSIONS_DISABLED'});
      // Immediate manual starts require an explicit offset and may only be recent.
      const startedAt = dto.startMode==='now' ? now : new Date(dto.startsAt ?? '');
      if (!Number.isFinite(startedAt.getTime()) || (dto.startMode==='manual' && !/(Z|[+-]\d{2}:\d{2})$/.test(dto.startsAt ?? '')) || startedAt > now || now.getTime()-startedAt.getTime()>60000) throw new BadRequestException({code:'SESSION_START_TIME_INVALID'});
      const {unit,rule} = await this.rate(tx,dto.venueId,dto.unitId,startedAt,dto.playMode);
      let expectedEnd = dto.durationMinutes ? new Date(startedAt.getTime()+dto.durationMinutes*60000) : null;
      const booking = dto.bookingId ? await tx.booking.findFirst({where:{id:dto.bookingId,venueId:dto.venueId,courtId:dto.unitId,status:'confirmed'},include:{payments:{where:{status:{in:['paid','refunded']}}}}}) : null;
      if (dto.bookingId && (!booking || booking.slotStart>now || booking.slotEnd<=now)) throw new BadRequestException({code:'BOOKING_CHECKIN_INVALID'});
      if (booking && dto.playMode === 'multi') throw new BadRequestException({code:'BOOKING_PLAY_MODE_LOCKED'});
      if (booking) { await assertStaffPermission(tx as never,user,'bookings.checkin'); expectedEnd=booking.slotEnd; }
      const customer = dto.customerId ? await tx.venueCustomer.findFirst({where:{id:dto.customerId,venueId:dto.venueId}}) : null;
      if (dto.customerId && !customer) throw new ForbiddenException({code:'CUSTOMER_NOT_ACCESSIBLE'});
      if (dto.customerId || dto.guestName || dto.guestPhone) await assertStaffPermission(tx as never,user,'customers.view');
      const order = dto.orderId ? await this.commands.versionOrder(tx,dto.venueId,dto.orderId,dto.orderVersion ?? 0) : await tx.gamingOrder.create({data:{venueId:dto.venueId,currency:venue.currency,moneyScale:isoMoneyScale(venue.currency),createdById:user.id,customerId:dto.customerId,guestName:dto.guestName?.trim()||null,guestPhone:dto.guestPhone?guestPhoneForStorage(dto.guestPhone,venue.countryCode):null}});
      if (dto.orderId) await assertStaffPermission(tx as never,user,'orders.manage');
      const session = await tx.usageSession.create({data:{venueId:dto.venueId,unitId:unit.id,orderId:order.id,bookingId:booking?.id,startedAt,expectedEnd,policy:venue.gamingBillingPolicy ?? exact as unknown as Prisma.InputJsonValue,createdById:user.id}});
      const snap = {playMode:dto.playMode??'standard',controllers:dto.playMode==='multi'?4:2,ruleId:rule.id,label:rule.label,hourlyRateMinor:rule.priceAmount,currency:rule.currency,bookingTotalMinor:booking?.membershipCovered ? 0 : booking?rescaleMoney(booking.totalAmount,100,order.moneyScale):null,coveredUntil:booking?.slotEnd.toISOString() ?? null,membershipCovered:booking?.membershipCovered ?? false};
      await tx.usageSegment.create({data:{sessionId:session.id,unitId:unit.id,startedAt,hourlyRateMinor:rule.priceAmount,currency:venue.currency,rateSnapshot:snap}});
      const line = await tx.gamingOrderLine.create({data:{orderId:order.id,kind:booking?'booking-time':'time',sourceId:session.id,nameAr:unit.name,nameEn:unit.name,quantity:1,unitPriceMinor:rule.priceAmount,amountMinor:booking && !booking.membershipCovered ? rescaleMoney(booking.totalAmount,100,order.moneyScale) : 0,snapshot:{policy:session.policy,rate:snap,startedAt:startedAt.toISOString()}}});
      if (booking) {
        await tx.gamingOrderLine.create({data:{orderId:order.id,kind:'time',sourceId:session.id,nameAr:unit.name,nameEn:unit.name,quantity:1,unitPriceMinor:rule.priceAmount,amountMinor:0,snapshot:{policy:session.policy,overrun:true}}});
        await tx.booking.update({where:{id:booking.id},data:{checkedInAt:now,checkedInByUserId:user.id}});
        for (const payment of booking.payments) {
          await tx.payment.update({where:{id:payment.id},data:{gamingOrderId:order.id}});
          await tx.gamingPaymentAllocation.create({data:{paymentId:payment.id,lineId:line.id,amountMinor:rescaleMoney(payment.amount,payment.moneyScale,order.moneyScale)}});
        }
        await this.ledger.syncBookingLedger(tx,booking.id,'gaming check-in');
      }
      await this.refreshOrder(tx,order.id,now);
      await this.commands.event(tx,dto.venueId,session.id,1,'session.started');
      return {...session,serverNow:now.toISOString()};
    });
  }
  private async session(tx: Prisma.TransactionClient, venueId: string, id: string, version: number) {
    const s=await tx.usageSession.findFirst({where:{id,venueId},include:{segments:{orderBy:{startedAt:'asc'}}}});
    if(!s) throw new ForbiddenException({code:'SESSION_NOT_ACCESSIBLE'});
    if(s.version!==version) throw new ConflictException({code:'SESSION_VERSION_CONFLICT',latestVersion:s.version});
    if(s.state!=='running') throw new BadRequestException({code:'SESSION_ENDED'});
    return s;
  }
  changePlayMode(user:AuthenticatedUser,id:string,dto:ChangePlayModeDto) {
    return this.commands.command(user,'sessions.transfer',`session.play-mode:${id}`,dto,async(tx,now)=>{
      const s=await this.session(tx,dto.venueId,id,dto.expectedVersion);
      if(s.bookingId)throw new BadRequestException({code:'BOOKING_PLAY_MODE_LOCKED'});
      const current=gamingConfigObject(s.segments[s.segments.length-1]?.rateSnapshot).playMode??'standard';
      if(current===dto.playMode)return {...s,serverNow:now.toISOString()};
      const {rule}=await this.rate(tx,dto.venueId,s.unitId,now,dto.playMode);
      await tx.usageSegment.updateMany({where:{sessionId:id,endedAt:null},data:{endedAt:now}});
      await tx.usageSegment.create({data:{sessionId:id,unitId:s.unitId,startedAt:now,hourlyRateMinor:rule.priceAmount,currency:rule.currency,rateSnapshot:{ruleId:rule.id,label:rule.label,playMode:dto.playMode,controllers:dto.playMode==='multi'?4:2}}});
      const result=await tx.usageSession.update({where:{id},data:{version:{increment:1}}});
      await this.refreshOrder(tx,s.orderId,now);
      await this.commands.event(tx,dto.venueId,id,result.version,'session.changed');
      return {...result,serverNow:now.toISOString()};
    });
  }
  tariffs(user:AuthenticatedUser,dto:UnitTariffDto) {
    return this.commands.command(user,'pricing.manage','unit.tariffs',dto,async tx=>{
      const unit=await tx.court.findFirst({where:{id:dto.unitId,venueId:dto.venueId},include:{sport:true}});
      if(!unit||!['gaming-station','table-game'].includes(unit.sport.activityKind??''))throw new BadRequestException({code:'INVALID_GAMING_UNIT'});
      const config=gamingConfigObject(unit.gamingConfig);
      const next={...config}; delete next.multiHourlyRateMinor;
      if(dto.multiHourlyRateMinor!==undefined){next.multiHourlyRateMinor=dto.multiHourlyRateMinor;selectGamingTariff(next,dto.hourlyRateMinor,'multi');}
      const venue=await tx.venue.findUniqueOrThrow({where:{id:dto.venueId}});
      await tx.court.update({where:{id:unit.id},data:{gamingHourlyRateMinor:dto.hourlyRateMinor,...(unit.sport.activityKind==='gaming-station'?{gamingConfig:next as Prisma.InputJsonValue}: {})}});
      // Booking APIs use the same standard base tariff; running sessions keep their snapshots.
      const baseAmount=Math.round(rescaleMoney(dto.hourlyRateMinor,isoMoneyScale(venue.currency),100));
      const updated=await tx.pricingRule.updateMany({where:{courtId:unit.id,label:'base'},data:{priceAmount:baseAmount}});
      if(!updated.count)await tx.pricingRule.create({data:{courtId:unit.id,label:'base',daysOfWeek:[],startTime:'00:00',endTime:'24:00',priceAmount:baseAmount,currency:venue.currency}});
      const rules=await tx.pricingRule.findMany({where:{courtId:unit.id}});
      if(rules.length===1&&rules[0].label==='base'&&rules[0].startTime==='00:00'&&rules[0].endTime==='24:00'&&rules[0].daysOfWeek.length===0)await tx.court.update({where:{id:unit.id},data:{gamingHourlyRateMinor:dto.hourlyRateMinor}});
      await this.commands.event(tx,dto.venueId,unit.id,null,'unit.tariffs_changed');
      return {unitId:unit.id,hourlyRateMinor:dto.hourlyRateMinor,multiHourlyRateMinor:dto.multiHourlyRateMinor??null};
    });
  }
  end(user: AuthenticatedUser,id: string,dto: GamingVersionDto) {
    return this.commands.command(user,'sessions.end',`session.end:${id}`,dto,async(tx,now)=>{
      const s=await this.session(tx,dto.venueId,id,dto.expectedVersion);
      await tx.usageSegment.updateMany({where:{sessionId:id,endedAt:null},data:{endedAt:now}});
      if(s.bookingId) {await tx.booking.update({where:{id:s.bookingId},data:{status:'completed'}}); await this.ledger.syncBookingLedger(tx,s.bookingId,'gaming end');}
      const ended=await tx.usageSession.update({where:{id},data:{state:'ended',endedAt:now,version:{increment:1}}});
      await this.refreshOrder(tx,s.orderId,now); await this.commands.event(tx,dto.venueId,id,ended.version,'session.ended');
      return {...ended,serverNow:now.toISOString()};
    });
  }
  correctEnd(user:AuthenticatedUser,id:string,dto:CorrectSessionEndDto) {
    return this.commands.command(user,'sessions.correct',`session.correct-end:${id}`,dto,async(tx,now)=>{
      const s=await this.session(tx,dto.venueId,id,dto.expectedVersion);
      const at=new Date(dto.endedAt);
      if(!dto.reason.trim()||!/(Z|[+-]\d{2}:\d{2})$/.test(dto.endedAt)||!Number.isFinite(at.getTime())||at>now||at<s.segments[s.segments.length-1].startedAt)throw new BadRequestException({code:'CORRECTION_TIME_INVALID'});
      await tx.usageSegment.updateMany({where:{sessionId:id,endedAt:null},data:{endedAt:at}});
      if(s.bookingId){await tx.booking.update({where:{id:s.bookingId},data:{status:'completed'}});await this.ledger.syncBookingLedger(tx,s.bookingId,'gaming corrected end');}
      const result=await tx.usageSession.update({where:{id},data:{state:'ended',endedAt:at,version:{increment:1}}});
      await tx.auditLogEntry.create({data:{actorUserId:user.id,action:'owner.gaming.session.corrected',targetType:'session',targetId:id,metadata:{reason:dto.reason,endedAt:at.toISOString(),serverNow:now.toISOString()}}});
      await this.refreshOrder(tx,s.orderId,now);await this.commands.event(tx,dto.venueId,id,result.version,'session.ended');return result;
    });
  }
  async syncBookingPayment(tx:Prisma.TransactionClient,bookingId:string) {
    const b=await tx.booking.findUniqueOrThrow({where:{id:bookingId}});
    const payments=await tx.payment.findMany({where:{bookingId,status:{in:['paid','refunded']}}});let received=payments.reduce((s,p)=>s+p.amount,0);
    const session=await tx.usageSession.findUnique({where:{bookingId}});if(session){const allocation=await tx.gamingPaymentAllocation.aggregate({where:{line:{sourceId:session.id,kind:'booking-time'},payment:{bookingId:null,status:{in:['paid','refunded']}}},_sum:{amountMinor:true}});const order=await tx.gamingOrder.findUniqueOrThrow({where:{id:session.orderId}});received+=rescaleMoney(allocation._sum.amountMinor??0,order.moneyScale,100);}
    await tx.booking.update({where:{id:bookingId},data:{paymentStatus:received>=b.totalAmount?'paid':received>0?'partial':'pending'}});
    await this.ledger.syncBookingLedger(tx,bookingId,'gaming refund');
  }
  extend(user: AuthenticatedUser,id: string,dto: ExtendSessionDto) {
    return this.commands.command(user,'sessions.transfer',`session.extend:${id}`,dto,async(tx,now)=>{
      const s=await this.session(tx,dto.venueId,id,dto.expectedVersion);
      if(!s.expectedEnd) throw new BadRequestException({code:'OPEN_SESSION_CANNOT_EXTEND'});
      const expectedEnd=new Date(Math.max(s.expectedEnd.getTime(),now.getTime())+dto.additionalMinutes*60000);
      const result=await tx.usageSession.update({where:{id},data:{expectedEnd,version:{increment:1}}});
      await this.commands.event(tx,dto.venueId,id,result.version,'session.changed'); return {...result,serverNow:now.toISOString()};
    });
  }
  transfer(user: AuthenticatedUser,id: string,dto: TransferSessionDto) {
    return this.commands.command(user,'sessions.transfer',`session.transfer:${id}`,dto,async(tx,now)=>{
      const s=await this.session(tx,dto.venueId,id,dto.expectedVersion);
      if(dto.targetUnitId===s.unitId) throw new BadRequestException({code:'SAME_UNIT'});
      const playMode=(gamingConfigObject(s.segments[s.segments.length-1]?.rateSnapshot).playMode??'standard') as PlayMode;
      const {unit,rule}=await this.rate(tx,dto.venueId,dto.targetUnitId,now,playMode);
      // The shared venue lock precedes sorted resource locks for opposite transfers.
      await tx.$queryRaw(Prisma.sql`SELECT id FROM "Court" WHERE id IN (${Prisma.join([s.unitId,unit.id].sort())}) ORDER BY id FOR UPDATE`);
      await tx.usageSegment.updateMany({where:{sessionId:id,endedAt:null},data:{endedAt:now}});
      await tx.usageSegment.create({data:{sessionId:id,unitId:unit.id,startedAt:now,hourlyRateMinor:rule.priceAmount,currency:rule.currency,rateSnapshot:{ruleId:rule.id,label:rule.label,playMode,controllers:playMode==='multi'?4:2}}});
      const result=await tx.usageSession.update({where:{id},data:{unitId:unit.id,version:{increment:1}}});
      await this.refreshOrder(tx,s.orderId,now); await this.commands.event(tx,dto.venueId,id,result.version,'session.changed');return {...result,serverNow:now.toISOString()};
    });
  }
  void(user: AuthenticatedUser,id: string,dto: ReasonCommandDto) {
    return this.commands.command(user,'sessions.correct',`session.void:${id}`,dto,async(tx,now)=>{
      if(!dto.reason.trim()) throw new BadRequestException({code:'REASON_REQUIRED'});
      const s=await this.session(tx,dto.venueId,id,dto.expectedVersion);
      if(s.bookingId || await tx.payment.count({where:{gamingOrderId:s.orderId}})) throw new ConflictException({code:'SESSION_HAS_FINANCIAL_HISTORY'});
      await tx.usageSegment.updateMany({where:{sessionId:id,endedAt:null},data:{endedAt:now}});
      const result=await tx.usageSession.update({where:{id},data:{state:'voided',endedAt:now,version:{increment:1}}});
      await tx.gamingOrderLine.updateMany({where:{orderId:s.orderId,sourceId:id},data:{amountMinor:0,snapshot:{voidReason:dto.reason}}});
      await this.refreshOrder(tx,s.orderId,now); await this.commands.event(tx,dto.venueId,id,result.version,'session.ended');return result;
    });
  }
  charge(s:UsageSession & {segments:UsageSegment[]},now:Date){return calculateUsageCharge(s,now);}
  async refreshOrder(tx:Prisma.TransactionClient,orderId:string,now:Date) {
    const sessions=await tx.usageSession.findMany({where:{orderId},include:{segments:{orderBy:{startedAt:'asc'}}}});
    for(const s of sessions) await tx.gamingOrderLine.updateMany({where:{orderId,kind:'time',sourceId:s.id},data:{amountMinor:this.charge(s,now),snapshot:jsonValue({policy:s.policy,startedAt:s.startedAt,endedAt:s.endedAt,segments:s.segments,estimated:s.state==='running'})}});
    const lines=await tx.gamingOrderLine.findMany({where:{orderId}});
    const total=lines.reduce((sum,l)=>sum+(l.kind==='discount'?-1:1)*l.amountMinor,0);
    if(!Number.isSafeInteger(total)||total<0||total>2147483647) throw new BadRequestException({code:'ORDER_AMOUNT_INVALID'});
    const order=await tx.gamingOrder.update({where:{id:orderId},data:{totalMinor:total,version:{increment:1}}});
    await this.commands.event(tx,order.venueId,orderId,order.version,'order.updated');return order;
  }
  async board(user:AuthenticatedUser,venueId:string,at?:string) {
    await this.commands.access(this.prisma,user,venueId,'bookings.view',false);
    const scope=user.roles.includes('staff')?await loadStaffScope(this.prisma,user.id):null;
    const privileged=!user.roles.includes('staff')||user.roles.includes('owner')||user.roles.includes('admin'); const money=privileged||scopeCan(scope,'reports.view')||scopeCan(scope,'payments.record'); const customers=privileged||scopeCan(scope,'customers.view');
    const now=new Date(),instant=at?new Date(at):now;if(at&&(!/(Z|[+-]\d{2}:\d{2})$/.test(at)||!Number.isFinite(instant.getTime())||Math.abs(instant.getTime()-now.getTime())>30*86400000))throw new BadRequestException({code:'SESSION_START_TIME_INVALID'});
    const [units,sessions,bookings,blocks]=await Promise.all([
      this.prisma.court.findMany({where:{venueId,sport:{activityKind:{in:['gaming-station','table-game']}}},include:{gamingRoom:{select:{occupancy:true,bookableCourtId:true}},sport:{select:{activityKind:true}},pricingRules:true,venue:{include:{country:true}},bookableRoom:{include:{children:{select:{id:true}}}}},orderBy:{name:'asc'}}),
      this.prisma.usageSession.findMany({where:{venueId,state:'running'},include:{segments:{orderBy:{startedAt:'asc'}},order:{include:{lines:true,payments:{where:{status:{in:['paid','refunded']}}}}}}}),
      this.prisma.booking.findMany({where:{venueId,status:{in:['held','confirmed']},slotEnd:{gt:now}},select:{id:true,courtId:true,slotStart:true,slotEnd:true,status:true},orderBy:{slotStart:'asc'},take:1000}),
      this.prisma.resourceOccupancy.findMany({where:{resource:{venueId},OR:[{running:true},{endsAt:{gt:now}},{endsAt:null}]},orderBy:{startsAt:'asc'}})
    ]);
    return {venueId,serverNow:now.toISOString(),...(at?{inspectAt:instant.toISOString()}:{}),units:units.map(u=>{
      const resources=new Set([u.id,...(u.bookableRoom?.occupancy==='exclusive'?u.bookableRoom.children.map(c=>c.id):[])]);const shared=blocks.filter(x=>resources.has(x.resourceId));
      const occupancy=shared.find(x=>x.startsAt<=instant&&(x.endsAt===null||x.endsAt>instant||x.running&&(!at||sessions.some(s=>s.id===x.sessionId&&s.expectedEnd&&s.expectedEnd<=now)))); const s=sessions.find(x=>x.id===occupancy?.sessionId);const future=shared.find(x=>x.startsAt>instant);const next=bookings.find(x=>x.id===future?.bookingId);const availableUntil=future?.startsAt??null;
      const currentBooking=bookings.find(b=>b.id===occupancy?.bookingId&&b.courtId===u.id)??null;
      const estimate=s?this.charge(s,now):0;
      const rule=coveringPricingRule(u.pricingRules,zonedWeekday(instant,u.venue.country.timezone),instant,u.venue.country.timezone);
      const hourlyRateMinor=rule?u.gamingHourlyRateMinor??rescaleMoney(rule.priceAmount,100,isoMoneyScale(u.venue.currency)):null;
      const base=u.pricingRules.find(r=>r.label==='base'&&r.startTime==='00:00'&&r.endTime==='24:00'&&!r.daysOfWeek.length);
      const baseHourlyRateMinor=base?u.gamingHourlyRateMinor??rescaleMoney(base.priceAmount,100,isoMoneyScale(u.venue.currency)):null;
      return {id:u.id,name:u.name,roomParentId:u.gamingRoom?.occupancy==='exclusive'&&(gamingConfigObject(u.gamingConfig).setupWholeRoomOnly===true||gamingConfigObject(u.tableConfig).setupWholeRoomOnly===true)?u.gamingRoom.bookableCourtId:null,published:u.gamingPublished,activityKind:u.sport.activityKind,...(money?{hourlyRateMinor,baseHourlyRateMinor,multiHourlyRateMinor:gamingConfigObject(u.gamingConfig).multiHourlyRateMinor??null}:{}),supportsMulti: ['ps4','ps5','xbox-series'].includes(String(gamingConfigObject(u.gamingConfig).consoleType)) && Number(gamingConfigObject(u.gamingConfig).multiHourlyRateMinor)>0,availableUntil,blockId:occupancy?.blockId??null,state:s?'in-use':occupancy?.blockId?'maintenance':occupancy?.bookingId?'held':'available',nextBooking:next??null,currentBooking,
        session:s?{id:s.id,unitId:s.unitId,orderId:s.orderId,version:s.version,state:s.state,startedAt:s.startedAt,expectedEnd:s.expectedEnd,bookingId:s.bookingId,playMode:gamingConfigObject(s.segments[s.segments.length-1]?.rateSnapshot).playMode??'standard',dueToEnd:!!s.expectedEnd&&s.expectedEnd<=now,policy:s.policy,
          ...(customers?{guestName:s.order.guestName,customerId:s.order.customerId}:{}),...(money?{estimatedMinor:estimate,currency:s.order.currency,receivedMinor:s.order.payments.reduce((sum,p)=>sum+rescaleMoney(p.amount,p.moneyScale,s.order.moneyScale),0),lines:s.order.lines}: {})}:null};
    })};
  }
}
