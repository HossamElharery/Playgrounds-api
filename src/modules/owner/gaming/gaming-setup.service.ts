import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { assertStaffPermission } from '../../../common/access/owner-access';
import { AuthenticatedUser } from '../../../common/types/authenticated-user.interface';
import { isoMoneyScale,rescaleMoney } from '../../../common/money/money-scale';
import { GamingCommandService } from './gaming-command.service';
import { GamingLayoutService } from './gaming-layout.service';
import { GamingSetupDto, SetupKind } from './gaming-setup.dto';
import { buildSetupLayout, PlannedUnit, validateSetupPlan } from './setup-plan';
import { gamingConfigObject } from './gaming-tariff';
@Injectable()
export class GamingSetupService {
 constructor(private readonly commands:GamingCommandService,private readonly layouts:GamingLayoutService){}
 private async permissions(db:Prisma.TransactionClient,user:AuthenticatedUser){
  for(const p of ['pricing.manage','layout.edit','layout.publish'] as const)await assertStaffPermission(db as never,user,p);
 }
 async status(user:AuthenticatedUser,venueId:string){
  await this.commands.access(this.commands.prisma,user,venueId,'venue.manage',false);
  await this.permissions(this.commands.prisma as never,user);
  const db=this.commands.prisma;
  const [layout,units,dependencies]=await Promise.all([
   db.gamingLayout.findUnique({where:{venueId}}),
   db.court.findMany({where:{venueId,sport:{activityKind:{in:['gaming-station','table-game']}}},include:{sport:{select:{activityKind:true}}},orderBy:{name:'asc'}}),
   db.resourceOccupancy.count({where:{resource:{venueId},OR:[{running:true},{endsAt:{gt:new Date()}}]}})
  ]);
  const revision=layout?.revision??0;
  const published=revision?await db.gamingLayoutRevision.findUnique({where:{venueId_revision:{venueId,revision}}}):null;
  const used=await db.usageSession.count({where:{venueId}});
  const bookings=await db.booking.count({where:{venueId}});
  const eligible=!layout?.draft&&(!revision||published?.requestHash==='auto-default')&&!dependencies&&!used&&!bookings;
  return {eligible,revision,units:units.map(u=>({id:u.id,name:u.name,assetKey:u.sport.activityKind==='table-game'?gamingConfigObject(u.tableConfig).tableType??'billiards':gamingConfigObject(u.gamingConfig).consoleType??'ps5',hourlyRateMinor:u.gamingHourlyRateMinor,multiHourlyRateMinor:gamingConfigObject(u.gamingConfig).multiHourlyRateMinor??null}))};
 }
 async setup(user:AuthenticatedUser,d:GamingSetupDto){
  try{validateSetupPlan(d);}catch{throw new BadRequestException({code:'SETUP_INVALID'});}
  await this.permissions(this.commands.prisma as never,user);
  return this.commands.command(user,'venue.manage','hall.setup',d,async tx=>{
   // Same lock order as normal layout publishing; serialize setup, layout and operational writes.
   await tx.$queryRaw`SELECT id FROM "Venue" WHERE id=${d.venueId} FOR UPDATE`;
   await this.permissions(tx,user);
   const layout=await tx.gamingLayout.findUnique({where:{venueId:d.venueId}});
   if((layout?.revision??0)!==d.expectedRevision||layout?.draft)throw new ConflictException({code:'SETUP_ALREADY_CONFIGURED'});
   const prior=layout?.revision?await tx.gamingLayoutRevision.findUnique({where:{venueId_revision:{venueId:d.venueId,revision:layout.revision}}}):null;
   if(prior&&prior.requestHash!=='auto-default')throw new ConflictException({code:'SETUP_ALREADY_CONFIGURED'});
   if(await tx.usageSession.count({where:{venueId:d.venueId}})||await tx.booking.count({where:{venueId:d.venueId}})||await tx.resourceOccupancy.count({where:{resource:{venueId:d.venueId},OR:[{running:true},{endsAt:{gt:new Date()}}]}}))throw new ConflictException({code:'RESOURCE_HAS_DEPENDENCIES'});
   const existing=await tx.court.findMany({where:{venueId:d.venueId,sport:{activityKind:{in:['gaming-station','table-game']}}},include:{sport:true},orderBy:{name:'asc'}});
   if(existing.length&&!d.reuseExisting)throw new ConflictException({code:'SETUP_EXISTING_UNITS'});
   const kind=(u:typeof existing[number])=>u.sport.activityKind==='table-game'?gamingConfigObject(u.tableConfig).tableType??'billiards':gamingConfigObject(u.gamingConfig).consoleType??'ps5';
   for(const u of existing)if(existing.filter(x=>kind(x)===kind(u)).length>(d.groups.find(g=>g.assetKey===kind(u))?.count??0))throw new ConflictException({code:'SETUP_EXISTING_UNITS'});
   const venue=await tx.venue.findUniqueOrThrow({where:{id:d.venueId}});
   const sports=await tx.sportCategory.findMany({where:{activityKind:{in:['gaming-station','table-game']}}});
   const planned:PlannedUnit[]=[],used=new Set<string>();
   const labels:Record<SetupKind,string>={ps5:'PS5',ps4:'PS4','xbox-series':'Xbox',pc:'PC',vr:'VR',billiards:d.language==='ar'?'بلياردو':'Billiards','table-tennis':d.language==='ar'?'تنس طاولة':'Table tennis'};
   const create=async(assetKey:SetupKind,name:string,rate:number,multi:number|undefined,roomIndex?:number,parent=false)=>{
    const table=['billiards','table-tennis'].includes(assetKey);
    const sport=sports.find(s=>table?s.slug===assetKey&&s.activityKind==='table-game':s.activityKind==='gaming-station');
    if(!sport)throw new BadRequestException({code:'ACTIVITY_NOT_CONFIGURED'});
    const source=!parent?existing.find(u=>kind(u)===assetKey&&!used.has(u.id)):undefined;
    const config={...gamingConfigObject(source?.gamingConfig),consoleType:assetKey,seats:multi?4:2,roomTier:roomIndex===undefined?'standard':'vip-big-screen',setupWholeRoomOnly:roomIndex!==undefined&&!parent&&d.rooms[roomIndex].occupancy==='exclusive',...(multi!==undefined?{multiHourlyRateMinor:multi}:{})};
    if(multi===undefined)delete (config as Record<string,unknown>).multiHourlyRateMinor;
    const data={gamingHourlyRateMinor:rate,gamingPublished:true,...(table?{tableConfig:{...gamingConfigObject(source?.tableConfig),tableType:assetKey,rentalAvailable:false,setupWholeRoomOnly:roomIndex!==undefined&&!parent&&d.rooms[roomIndex].occupancy==='exclusive'}}:{gamingConfig:config as Prisma.InputJsonValue})};
    const pricing={label:'base',daysOfWeek:[] as number[],startTime:'00:00',endTime:'24:00',priceAmount:Math.round(rescaleMoney(rate,isoMoneyScale(venue.currency),100)),currency:venue.currency};
    const u=source?await tx.court.update({where:{id:source.id},data}):await tx.court.create({data:{...data,venueId:d.venueId,sportId:sport.id,name,slotDurationMins:60,pricingRules:{create:pricing}}});
    used.add(u.id);
    if(source){
      // Reuse keeps identity and any custom schedule rules; only replace the standard base tariff.
      await tx.pricingRule.deleteMany({where:{courtId:u.id,label:'base'}});
      await tx.pricingRule.create({data:{...pricing,courtId:u.id}});
      if(await tx.pricingRule.count({where:{courtId:u.id}})===1)await tx.court.update({where:{id:u.id},data:{gamingHourlyRateMinor:rate}});
    }
    return u.id;
   };
   for(const g of d.groups){
    let number=0;
    for(let ri=0;ri<d.rooms.length;ri++){
     const r=d.rooms[ri],count=r.members.find(m=>m.assetKey===g.assetKey)?.count??0;
     for(let i=0;i<count;i++)planned.push({id:await create(g.assetKey,`${labels[g.assetKey]} ${++number}`,g.privateHourlyRateMinor??g.hourlyRateMinor,g.privateMultiHourlyRateMinor??g.multiHourlyRateMinor,ri),assetKey:g.assetKey,floorIndex:r.floorIndex,roomIndex:ri});
    }
    const openFloors=g.floorCounts??Array.from({length:d.floorCount},(_,f)=>f===g.floorIndex?g.count-number:0);
    for(let f=0;f<openFloors.length;f++)for(let i=0;i<openFloors[f];i++)planned.push({id:await create(g.assetKey,`${labels[g.assetKey]} ${++number}`,g.hourlyRateMinor,g.multiHourlyRateMinor),assetKey:g.assetKey,floorIndex:f});
   }
   for(let ri=0;ri<d.rooms.length;ri++){
    const r=d.rooms[ri];if(r.occupancy==='exclusive')planned.push({id:await create(r.members[0].assetKey,r.name.trim(),r.hourlyRateMinor!,r.multiHourlyRateMinor,ri,true),assetKey:r.members[0].assetKey,floorIndex:r.floorIndex,roomIndex:ri,roomParent:true});
   }
   let document;
   try{document=buildSetupLayout(d,planned,randomUUID);}catch{throw new BadRequestException({code:'SETUP_NO_SPACE'});}
   await this.layouts.applyRooms(tx,d.venueId,document);
   const children=planned.filter(u=>u.roomIndex!==undefined&&!u.roomParent&&d.rooms[u.roomIndex].occupancy==='exclusive');
   await tx.court.updateMany({where:{id:{in:children.map(u=>u.id)}},data:{gamingPublished:false}});
   const revision=(layout?.revision??0)+1;
   await tx.gamingLayoutRevision.create({data:{venueId:d.venueId,revision,document:document as unknown as Prisma.InputJsonValue,requestKey:d.requestKey,requestHash:`setup:${user.id}`,createdById:user.id}});
   await tx.gamingLayout.upsert({where:{venueId:d.venueId},create:{venueId:d.venueId,revision},update:{revision,draft:Prisma.DbNull}});
   await tx.venue.update({where:{id:d.venueId},data:{gamingSessionsEnabled:true,gamingProductsEnabled:true,gamingReceiptsEnabled:true}});
   await this.commands.event(tx,d.venueId,d.venueId,revision,'layout.published');
   return {venueId:d.venueId,revision,unitCount:d.groups.reduce((n,g)=>n+g.count,0),roomCount:d.rooms.length,document};
  });
 }
}
