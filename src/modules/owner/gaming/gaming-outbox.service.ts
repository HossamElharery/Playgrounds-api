import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { RealtimeGatewayEmitter } from '../../realtime/realtime-emitter.interface';
import { NotificationsService } from '../../notifications/notifications.service';
import { withJobLock } from '../../../common/utils/job-lock.util';
import { GamingSessionsService } from './gaming-sessions.service';
import { rescaleMoney } from '../../../common/money/money-scale';
import { unpaidReminderSlot, UNPAID_FIRST_MS, UNPAID_WINDOW_MS } from './unpaid-reminder';
@Injectable()
export class GamingOutboxService {
 private readonly logger=new Logger(GamingOutboxService.name);
 constructor(private readonly prisma:PrismaService,private readonly realtime:RealtimeGatewayEmitter,private readonly notifications:NotificationsService,@Optional() private readonly sessions?:GamingSessionsService){}
 @Cron('*/5 * * * * *') async drain(){
  await withJobLock(this.prisma,'gaming-outbox',async()=>{
   const events=await this.prisma.gamingOutbox.findMany({where:{deliveredAt:null},orderBy:{createdAt:'asc'},take:100});
   for(const e of events){try{
    const venue=await this.prisma.venue.findUnique({where:{id:e.venueId},select:{ownerId:true}});if(!venue){continue;}
    const staff=await this.prisma.staffMember.findMany({where:{user:{roles:{has:'staff'},status:'active'},ownerId:venue.ownerId,venueIds:{has:e.venueId},permissions:{has:'bookings.view'}},select:{userId:true}});
    const payload={type:e.type,eventId:e.id,venueId:e.venueId,entityId:e.entityId,version:e.version,serverTime:e.createdAt.toISOString()};
    for(const id of new Set([venue.ownerId,...staff.map(s=>s.userId)]))this.realtime.emitToUser(id,payload);
    if(e.type==='layout.published')await this.notifications.create({dedupKey:`gaming-layout:${e.id}`,userId:venue.ownerId,category:'system',titleAr:'تم نشر توزيع الأجهزة',titleEn:'Station layout published',bodyAr:'راجع النسخة المنشورة من توزيع منشأتك.',bodyEn:'Review the published venue layout.',deepLink:'/owner/gaming-layout',payload:{venueId:e.venueId,revision:e.version}});
    await this.prisma.gamingOutbox.update({where:{id:e.id},data:{deliveredAt:new Date(),attempts:{increment:1}}});
   }catch{await this.prisma.gamingOutbox.update({where:{id:e.id},data:{attempts:{increment:1}}});this.logger.warn(`Gaming event retry ${e.id}`);}}
  });
 }
 @Cron('0 * * * * *') async reminders(){
  await withJobLock(this.prisma,'gaming-reminders',async()=>{
   const now=new Date();const sessions=await this.prisma.usageSession.findMany({where:{state:'running',expectedEnd:{lte:new Date(now.getTime()+5*60000)}},include:{venue:{select:{ownerId:true,nameAr:true,nameEn:true}},unit:{select:{name:true}}},take:200});
   for(const s of sessions){
    const targetId=`${s.id}:${s.expectedEnd!.toISOString()}`;
    const staff=await this.prisma.staffMember.findMany({where:{user:{roles:{has:'staff'},status:'active'},ownerId:s.venue.ownerId,venueIds:{has:s.venueId},permissions:{has:'sessions.end'}},select:{userId:true}});
    const people=new Set([s.venue.ownerId,...staff.map(x=>x.userId)]);
    // Time is up: tell the team now (the screen is about to go off, and the clock keeps running until someone ends the session).
    const overrun=(s.policy as {overrun?:string}|null)?.overrun;
    if(s.expectedEnd!<=now&&overrun!=='auto-end'&&!(await this.prisma.auditLogEntry.findFirst({where:{action:'owner.gaming.timeup',targetId}}))){
     try{for(const userId of people)await this.notifications.create({dedupKey:`gaming-timeup:${targetId}:${userId}`,userId,category:'system',titleAr:`${s.venue.nameAr}: انتهى وقت ${s.unit.name}`,titleEn:`${s.venue.nameEn}: time is up on ${s.unit.name}`,bodyAr:overrun==='continue'?`حصّل المبلغ أو مدّد الجلسة. ما زال العدّاد يعمل إلى أن تُنهى الجلسة.`:`حصّل المبلغ أو مدّد الجلسة. توقفت الفاتورة عند الوقت المحدد.`,bodyEn:overrun==='continue'?`Collect payment or extend the session. The clock keeps running until the session is ended.`:`Collect payment or extend the session. The bill stopped at the planned time.`,deepLink:'/owner/gaming',payload:{venueId:s.venueId,sessionId:s.id,eventId:`${targetId}:timeup`}});
     await this.prisma.auditLogEntry.create({data:{actorUserId:s.venue.ownerId,action:'owner.gaming.timeup',targetType:'session',targetId,metadata:{venueId:s.venueId}}});}catch{this.logger.warn(`Gaming time-up retry ${s.id}`);}
    }
    if(s.expectedEnd!<=now)continue; // already past: the time-up notice above says it
    if(await this.prisma.auditLogEntry.findFirst({where:{action:'owner.gaming.reminder',targetId}}))continue;
    try{for(const userId of people)await this.notifications.create({dedupKey:`gaming-reminder:${targetId}:${userId}`,userId,category:'system',titleAr:`${s.venue.nameAr}: قرب انتهاء الجلسة`,titleEn:`${s.venue.nameEn}: session due to end`,bodyAr:`راجع جلسة ${s.unit.name} وأنهِها أو مددها.`,bodyEn:`Review ${s.unit.name} and end or extend the session.`,deepLink:'/owner/gaming',payload:{venueId:s.venueId,sessionId:s.id,eventId:targetId}});
    await this.prisma.auditLogEntry.create({data:{actorUserId:s.venue.ownerId,action:'owner.gaming.reminder',targetType:'session',targetId,metadata:{venueId:s.venueId}}});
    }catch{this.logger.warn(`Gaming reminder retry ${s.id}`);}
   }
  });
 }
 // A session was ended but nobody collected: keep reminding the team (bell + push) until the bill is paid, so it is never forgotten.
 @Cron('30 * * * * *') async unpaidReminders(){
  await withJobLock(this.prisma,'gaming-unpaid-reminders',async()=>{
   const now=new Date();
   const orders=await this.prisma.gamingOrder.findMany({
    where:{state:'open',totalMinor:{gt:0},sessions:{some:{state:'ended',endedAt:{gte:new Date(now.getTime()-UNPAID_WINDOW_MS),lte:new Date(now.getTime()-UNPAID_FIRST_MS)}},none:{state:'running'}}},
    select:{id:true,venueId:true,totalMinor:true,moneyScale:true,currency:true,venue:{select:{ownerId:true,nameAr:true,nameEn:true}},sessions:{select:{endedAt:true,unit:{select:{name:true}}},where:{state:'ended'},orderBy:{endedAt:'desc'},take:1},payments:{where:{status:{in:['paid','refunded']}},select:{amount:true,moneyScale:true}}},
    take:100});
   for(const o of orders){
    try{
     const received=o.payments.reduce((sum,p)=>sum+rescaleMoney(p.amount,p.moneyScale,o.moneyScale),0);
     const remaining=o.totalMinor-received;
     const last=o.sessions[0];
     if(remaining<=0||!last?.endedAt)continue;
     const slot=unpaidReminderSlot((now.getTime()-last.endedAt.getTime())/60000);
     if(slot===null)continue;
     const staff=await this.prisma.staffMember.findMany({where:{user:{roles:{has:'staff'},status:'active'},ownerId:o.venue.ownerId,venueIds:{has:o.venueId},permissions:{has:'payments.record'}},select:{userId:true}});
     const amount=`${(remaining/o.moneyScale).toFixed(Math.max(0,Math.round(Math.log10(o.moneyScale))))} ${o.currency}`;
     const unit=last.unit.name;
     for(const userId of new Set([o.venue.ownerId,...staff.map(x=>x.userId)]))await this.notifications.create({dedupKey:`gaming-unpaid:${o.id}:${slot}:${userId}`,userId,category:'system',titleAr:`${o.venue.nameAr}: فاتورة ${unit} لم تُحصَّل`,titleEn:`${o.venue.nameEn}: ${unit} bill not collected`,bodyAr:`المتبقي ${amount}. افتح الجهاز وحصّل المبلغ حتى لا تُنسى الفاتورة.`,bodyEn:`${amount} is still due. Open the station and collect so the bill is not forgotten.`,deepLink:'/owner/gaming',payload:{venueId:o.venueId,orderId:o.id,eventId:`${o.id}:unpaid:${slot}`}});
    }catch{this.logger.warn(`Gaming unpaid reminder retry ${o.id}`);}
   }
  });
 }
 // Venues that chose "end automatically": close walk-in timed sessions at their planned end and tell the team to collect.
 @Cron('*/10 * * * * *') async autoEnd(){
  if(!this.sessions)return;
  await withJobLock(this.prisma,'gaming-auto-end',async()=>{
   const due=await this.prisma.usageSession.findMany({where:{state:'running',bookingId:null,expectedEnd:{lte:new Date()},policy:{path:['overrun'],equals:'auto-end'}},select:{id:true},take:50});
   for(const {id} of due){
    try{
     const done=await this.sessions!.autoEnd(id);
     if(!done)continue;
     const staff=await this.prisma.staffMember.findMany({where:{user:{roles:{has:'staff'},status:'active'},ownerId:done.ownerId,venueIds:{has:done.venueId},permissions:{has:'sessions.end'}},select:{userId:true}});
     for(const userId of new Set([done.ownerId,...staff.map(x=>x.userId)]))await this.notifications.create({dedupKey:`gaming-autoend:${id}:${userId}`,userId,category:'system',titleAr:`${done.nameAr}: انتهت جلسة ${done.unitName}`,titleEn:`${done.nameEn}: ${done.unitName} session ended`,bodyAr:`أُغلقت الجلسة تلقائيًا عند انتهاء وقتها. حصّل المبلغ.`,bodyEn:`The session closed by itself when its time ended. Collect payment.`,deepLink:'/owner/gaming',payload:{venueId:done.venueId,sessionId:id,eventId:`${id}:auto-end`}});
    }catch(error){this.logger.warn(`Gaming auto-end retry ${id}: ${(error as Error).message}`);}
   }
  });
 }
}
