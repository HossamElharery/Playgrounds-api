import { rescaleMoney } from '../../../common/money/money-scale';
import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuthenticatedUser } from '../../../common/types/authenticated-user.interface';
import { GamingCommandService, jsonValue } from './gaming-command.service';
import { GamingSessionsService } from './gaming-sessions.service';
import { BookingReceiptDto, GamingCommandDto, PrintJobDto, PrintStatusDto, ReceiptSettingsDto } from './gaming-operations.dto';
@Injectable()
export class GamingReceiptsService {
  constructor(private readonly commands: GamingCommandService,private readonly sessions:GamingSessionsService) {}
  async issue(tx:Prisma.TransactionClient,orderId:string,paymentId:string|null,actorId:string,kind='payment',originalId?:string) {
    const order=await tx.gamingOrder.findUniqueOrThrow({where:{id:orderId},include:{venue:{include:{country:true}},lines:{orderBy:[{createdAt:'asc'},{id:'asc'}]},payments:{where:{status:{in:['paid','refunded']}}}}});
    const settings=await tx.receiptSettings.upsert({where:{venueId:order.venueId},create:{venueId:order.venueId},update:{}});
    await tx.receiptSettings.update({where:{venueId:order.venueId},data:{nextNumber:{increment:1}}});
    const logo=settings.logoPhotoId?await tx.venuePhoto.findFirst({where:{id:settings.logoPhotoId,venueId:order.venueId}}):null;
    const payment=order.payments.find(p=>p.id===paymentId); const receivedMinor=order.payments.reduce((s,p)=>s+rescaleMoney(p.amount,p.moneyScale,order.moneyScale),0);
    // A transferred session spans several devices at different rates; freeze each leg (device name, times, rate) so the customer copy can show it.
    type Leg={unitId?:string;startedAt?:string;endedAt?:string|null;hourlyRateMinor?:number;rateSnapshot?:{playMode?:string}};
    const legsOf=(l:{snapshot:unknown})=>((l.snapshot as {segments?:Leg[]}|null)?.segments??[]);
    const unitIds=[...new Set(order.lines.filter(l=>l.kind==='time').flatMap(l=>legsOf(l).map(g=>g.unitId).filter((id):id is string=>!!id)))];
    const unitNames=new Map((unitIds.length?await tx.court.findMany({where:{id:{in:unitIds}},select:{id:true,name:true}}):[]).map(c=>[c.id,c.name]));
    const receiptLines=order.lines.map(l=>l.kind==='time'?{...l,snapshot:{...(l.snapshot as object),detail:legsOf(l).map(g=>({unitName:g.unitId?unitNames.get(g.unitId)??null:null,startedAt:g.startedAt??null,endedAt:g.endedAt??null,hourlyRateMinor:g.hourlyRateMinor??null,playMode:g.rateSnapshot?.playMode??null}))}}:l);
    const receipt=await tx.receiptDocument.create({data:{venueId:order.venueId,orderId,paymentId,number:settings.nextNumber,kind,originalId,snapshot:jsonValue({schemaVersion:1,kind,orderId,actorId,issuedAt:new Date(),venue:{nameAr:order.venue.nameAr,nameEn:order.venue.nameEn,timezone:order.venue.country.timezone,address:order.venue.address,legalBusinessName:order.venue.legalBusinessName},currency:order.currency,lines:receiptLines,totalMinor:order.totalMinor,receivedMinor,remainingMinor:Math.max(0,order.totalMinor-receivedMinor),payment:payment?{id:payment.id,amountMinor:rescaleMoney(payment.amount,payment.moneyScale,order.moneyScale),method:payment.method}:null,settings:{widthMm:settings.widthMm,language:settings.language,header:settings.header,footer:settings.footer,copies:settings.copies,logoUrl:logo?.url??null},guestName:null})}});
    return receipt;
  }
  async settings(user:AuthenticatedUser,venueId:string) {
    await this.commands.access(this.commands.prisma,user,venueId,'receipts.print',false,true);
    const venue=await this.commands.prisma.venue.findUniqueOrThrow({where:{id:venueId}});
    const row=await this.commands.prisma.receiptSettings.findUnique({where:{venueId}});
    const availableLogos=await this.commands.prisma.venuePhoto.findMany({where:{venueId},select:{id:true,url:true},orderBy:{position:'asc'}});
    return row?{enabled:venue.gamingReceiptsEnabled,availableLogos,logoPhotoId:row.logoPhotoId,widthMm:row.widthMm,language:row.language,header:row.header,footer:row.footer,copies:row.copies,autoPrint:row.autoPrint,version:row.version}:{enabled:venue.gamingReceiptsEnabled,availableLogos,logoPhotoId:null,widthMm:80,language:'bilingual',header:'',footer:'',copies:1,autoPrint:false,version:1};
  }
  configure(user:AuthenticatedUser,dto:ReceiptSettingsDto) {
    return this.commands.command(user,'printer.manage','receipt.settings',dto,async tx=>{
      if(dto.logoPhotoId&&!await tx.venuePhoto.findFirst({where:{id:dto.logoPhotoId,venueId:dto.venueId}}))throw new ForbiddenException({code:'LOGO_NOT_ACCESSIBLE'});
      if(dto.enabled!==undefined)await tx.venue.update({where:{id:dto.venueId},data:{gamingReceiptsEnabled:dto.enabled}});
      const current=await tx.receiptSettings.upsert({where:{venueId:dto.venueId},create:{venueId:dto.venueId},update:{}});
      if(current.version!==dto.expectedVersion) throw new ConflictException({code:'RECEIPT_SETTINGS_CONFLICT'});
      return tx.receiptSettings.update({where:{venueId:dto.venueId},data:{logoPhotoId:dto.logoPhotoId??null,widthMm:dto.widthMm,language:dto.language,header:dto.header.trim(),footer:dto.footer.trim(),copies:dto.copies,autoPrint:dto.autoPrint,version:{increment:1}}});
    },true);
  }
  async read(user:AuthenticatedUser,id:string) {
    const receipt=await this.commands.prisma.receiptDocument.findUnique({where:{id}});
    if(!receipt) throw new ForbiddenException({code:'RECEIPT_NOT_ACCESSIBLE'});
    await this.commands.access(this.commands.prisma,user,receipt.venueId,'receipts.print',false,true);return receipt;
  }
  bill(user:AuthenticatedUser,orderId:string,dto:GamingCommandDto) {
    return this.commands.command(user,'receipts.print',`receipt.bill:${orderId}`,dto,async (tx,now)=>{
      const order=await tx.gamingOrder.findFirst({where:{id:orderId,venueId:dto.venueId}});
      if(!order) throw new ForbiddenException({code:'ORDER_NOT_ACCESSIBLE'});
      await this.sessions.refreshOrder(tx,orderId,now);
      return this.issue(tx,orderId,null,user.id,'bill');
    });
  }
  booking(user:AuthenticatedUser,id:string,dto:BookingReceiptDto){
    return this.commands.command(user,'receipts.print',`receipt.booking:${id}`,dto,async tx=>{
      const b=await tx.booking.findFirst({where:{id,venueId:dto.venueId},include:{venue:{include:{country:true}},court:true,payments:{where:{status:{in:['paid','refunded']}}},usageSession:true}});
      if(!b)throw new ForbiddenException({code:'BOOKING_NOT_ACCESSIBLE'});
      if(!b.venue.gamingReceiptsEnabled)throw new ForbiddenException({code:'RECEIPTS_DISABLED'});
      if(b.usageSession)throw new ConflictException({code:'BOOKING_LINKED_TO_SESSION'});
      const payment=dto.paymentId?b.payments.find(p=>p.id===dto.paymentId):null;if(dto.paymentId&&!payment)throw new ForbiddenException({code:'PAYMENT_NOT_ACCESSIBLE'});
      const settings=await tx.receiptSettings.upsert({where:{venueId:dto.venueId},create:{venueId:dto.venueId},update:{}});await tx.receiptSettings.update({where:{venueId:dto.venueId},data:{nextNumber:{increment:1}}});
      const scale=10**(new Intl.NumberFormat('en',{style:'currency',currency:b.currency}).resolvedOptions().maximumFractionDigits??2),totalMinor=rescaleMoney(b.totalAmount,100,scale),receivedMinor=b.payments.reduce((sum,p)=>sum+rescaleMoney(p.amount,p.moneyScale,scale),0);const kind=payment?(payment.amount<0?'refund':'payment'):'bill';
      const logo=settings.logoPhotoId?await tx.venuePhoto.findFirst({where:{id:settings.logoPhotoId,venueId:dto.venueId}}):null;
      const original=payment?.reversesPaymentId?await tx.receiptDocument.findFirst({where:{venueId:dto.venueId,paymentId:payment.reversesPaymentId},select:{id:true}}):null;
      return tx.receiptDocument.create({data:{originalId:original?.id,venueId:dto.venueId,bookingId:id,orderId:null,paymentId:payment?.id,number:settings.nextNumber,kind,snapshot:jsonValue({schemaVersion:1,kind,actorId:user.id,venue:{nameAr:b.venue.nameAr,nameEn:b.venue.nameEn,address:b.venue.address,timezone:b.venue.country.timezone},currency:b.currency,lines:[{id:b.id,kind:'booking-time',sourceId:b.id,nameAr:b.court.name,nameEn:b.court.name,quantity:1,returnedQuantity:0,unitPriceMinor:totalMinor,amountMinor:totalMinor,snapshot:{startsAt:b.slotStart,endsAt:b.slotEnd}}],totalMinor,receivedMinor,remainingMinor:Math.max(0,totalMinor-receivedMinor),payment:payment?{id:payment.id,amountMinor:rescaleMoney(payment.amount,payment.moneyScale,scale),method:payment.method}:null,settings:{widthMm:settings.widthMm,language:settings.language,header:settings.header,footer:settings.footer,copies:settings.copies,logoUrl:logo?.url??null}})}});
    },true);
  }
  job(user:AuthenticatedUser,id:string,dto:PrintJobDto) {
    return this.commands.command(user,'receipts.print',`print.queue:${id}`,dto,async tx=>{
      const receipt=await tx.receiptDocument.findFirst({where:{id,venueId:dto.venueId}});
      if(!receipt) throw new ForbiddenException({code:'RECEIPT_NOT_ACCESSIBLE'});
      return tx.gamingPrintJob.create({data:{receiptId:id,actorId:user.id,terminalId:dto.terminalId}});
    },true);
  }
  status(user:AuthenticatedUser,id:string,dto:PrintStatusDto) {
    return this.commands.command(user,'receipts.print',`print.status:${id}`,dto,async tx=>{
      const job=await tx.gamingPrintJob.findFirst({where:{id,actorId:user.id,receipt:{venueId:dto.venueId}}});
      if(!job) throw new ForbiddenException({code:'PRINT_JOB_NOT_ACCESSIBLE'});
      if(job.status==='sent') throw new BadRequestException({code:'PRINT_JOB_ALREADY_SENT'});
      return tx.gamingPrintJob.update({where:{id},data:{status:dto.status,attempts:{increment:1}}});
    },true);
  }
}
