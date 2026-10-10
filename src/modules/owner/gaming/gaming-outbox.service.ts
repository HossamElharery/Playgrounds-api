import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { RealtimeGatewayEmitter } from '../../realtime/realtime-emitter.interface';
import { NotificationsService } from '../../notifications/notifications.service';
import { withJobLock } from '../../../common/utils/job-lock.util';
/** Minimal invalidations to authorized personal rooms; no customer/money payload. */
@Injectable()
export class GamingOutboxService {
 private readonly logger=new Logger(GamingOutboxService.name);
 constructor(private readonly prisma:PrismaService,private readonly realtime:RealtimeGatewayEmitter,private readonly notifications:NotificationsService){}
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
    if(await this.prisma.auditLogEntry.findFirst({where:{action:'owner.gaming.reminder',targetId}}))continue;
    const staff=await this.prisma.staffMember.findMany({where:{user:{roles:{has:'staff'},status:'active'},ownerId:s.venue.ownerId,venueIds:{has:s.venueId},permissions:{has:'sessions.end'}},select:{userId:true}});
    try{for(const userId of new Set([s.venue.ownerId,...staff.map(x=>x.userId)]))await this.notifications.create({dedupKey:`gaming-reminder:${targetId}:${userId}`,userId,category:'system',titleAr:`${s.venue.nameAr}: قرب انتهاء الجلسة`,titleEn:`${s.venue.nameEn}: session due to end`,bodyAr:`راجع جلسة ${s.unit.name} وأنهِها أو مددها.`,bodyEn:`Review ${s.unit.name} and end or extend the session.`,deepLink:'/owner/gaming',payload:{venueId:s.venueId,sessionId:s.id,eventId:targetId}});
    await this.prisma.auditLogEntry.create({data:{actorUserId:s.venue.ownerId,action:'owner.gaming.reminder',targetType:'session',targetId,metadata:{venueId:s.venueId}}});
    }catch{this.logger.warn(`Gaming reminder retry ${s.id}`);}
   }
  });
 }
}
