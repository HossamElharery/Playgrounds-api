import { isoMoneyScale,rescaleMoney } from '../../../common/money/money-scale';
import { guestPhoneForStorage } from '../../../common/utils/guest-phone.util';
import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuthenticatedUser } from '../../../common/types/authenticated-user.interface';
import { assertStaffAnyPermission, assertStaffPermission } from '../../../common/access/owner-access';
import { loadStaffScope, scopeCan } from '../../../common/access/staff-scope';
import { GamingCommandService, jsonValue } from './gaming-command.service';
import { GamingSessionsService } from './gaming-sessions.service';
import { GamingReceiptsService } from './gaming-receipts.service';
import { CollectOrderDto, CreateOrderDto, DiscountOrderDto, GamingVersionDto, ProductDto, ProductLineDto, QuantityDto, RefundOrderDto, ReturnLineDto, StockDto } from './gaming-operations.dto';
import { allocatePayment } from './session-billing';
@Injectable()
export class GamingCommerceService {
  constructor(private readonly commands:GamingCommandService,private readonly sessions:GamingSessionsService,private readonly receipts:GamingReceiptsService) {}
  private get prisma(){return this.commands.prisma;}
  private async enabled(tx:Prisma.TransactionClient,venueId:string) {
    const v=await tx.venue.findUniqueOrThrow({where:{id:venueId}});
    if(!v.gamingProductsEnabled) throw new ForbiddenException({code:'PRODUCTS_DISABLED'});return v;
  }
  async products(user:AuthenticatedUser,venueId:string,cursor?:string) {
    await this.commands.access(this.prisma,user,venueId,'products.view',false);
    if(cursor && !await this.prisma.gamingProduct.findFirst({where:{id:cursor,venueId}})) throw new ForbiddenException({code:'CURSOR_NOT_ACCESSIBLE'});
    const items=await this.prisma.gamingProduct.findMany({where:{venueId},orderBy:{id:'asc'},take:101,...(cursor?{cursor:{id:cursor},skip:1}:{})});
    return {items:items.slice(0,100),nextCursor:items.length>100?items[99].id:null};
  }
  product(user:AuthenticatedUser,dto:ProductDto,id?:string) {
    return this.commands.command(user,'products.manage',`product.save:${id??'new'}`,dto,async tx=>{
      const v=await this.enabled(tx,dto.venueId);
      if(!dto.nameAr.trim()&&!dto.nameEn.trim()) throw new BadRequestException({code:'PRODUCT_NAME_REQUIRED'});
      const data={nameAr:dto.nameAr.trim(),nameEn:dto.nameEn.trim(),category:dto.category.trim(),sku:dto.sku?.trim()||null,priceMinor:dto.priceMinor,stockTracked:dto.stockTracked,active:dto.active??true};
      if(!id){const result=await tx.gamingProduct.create({data:{...data,venueId:dto.venueId,currency:v.currency}});await this.commands.event(tx,dto.venueId,result.id,result.version,'product.availability_changed');return result;}
      const row=await tx.gamingProduct.findFirst({where:{id,venueId:dto.venueId}});
      if(!row) throw new ForbiddenException({code:'PRODUCT_NOT_ACCESSIBLE'});
      if(row.version!==dto.expectedVersion) throw new ConflictException({code:'PRODUCT_VERSION_CONFLICT'});
      if(row.stockTracked!==dto.stockTracked&&row.availableQuantity) throw new ConflictException({code:'STOCK_MODE_HAS_BALANCE'});
      const result=await tx.gamingProduct.update({where:{id},data:{...data,version:{increment:1}}});
      await tx.auditLogEntry.create({data:{actorUserId:user.id,action:'owner.gaming.product.changed',targetType:'product',targetId:id,metadata:{venueId:dto.venueId,before:{priceMinor:row.priceMinor,active:row.active,stockTracked:row.stockTracked},after:{priceMinor:result.priceMinor,active:result.active,stockTracked:result.stockTracked}}}});await this.commands.event(tx,dto.venueId,id,result.version,'product.availability_changed');return result;
    });
  }
  stock(user:AuthenticatedUser,id:string,dto:StockDto) {
    return this.commands.command(user,'products.manage',`product.stock:${id}`,dto,async tx=>{
      await this.enabled(tx,dto.venueId);
      const p=await tx.gamingProduct.findFirst({where:{id,venueId:dto.venueId}});
      if(!p) throw new ForbiddenException({code:'PRODUCT_NOT_ACCESSIBLE'});
      if(!p.stockTracked||!dto.delta||!dto.reason.trim()) throw new BadRequestException({code:'STOCK_ADJUSTMENT_INVALID'});
      if(p.version!==dto.expectedVersion) throw new ConflictException({code:'PRODUCT_VERSION_CONFLICT'});
      if(p.availableQuantity+dto.delta<0) throw new ConflictException({code:'INSUFFICIENT_STOCK'});
      await tx.gamingStockMovement.create({data:{productId:id,delta:dto.delta,reason:dto.reason.trim(),createdById:user.id}});
      const result=await tx.gamingProduct.update({where:{id},data:{availableQuantity:{increment:dto.delta},version:{increment:1}}});
      await this.commands.event(tx,dto.venueId,id,result.version,'product.availability_changed');return result;
    });
  }
  create(user:AuthenticatedUser,dto:CreateOrderDto) {
    return this.commands.command(user,'orders.manage','order.create',dto,async tx=>{
      const v=await this.enabled(tx,dto.venueId);
      if(dto.customerId||dto.guestName||dto.guestPhone) await assertStaffPermission(tx as never,user,'customers.view');
      if(dto.customerId&&!await tx.venueCustomer.findFirst({where:{id:dto.customerId,venueId:dto.venueId}})) throw new ForbiddenException({code:'CUSTOMER_NOT_ACCESSIBLE'});
      return tx.gamingOrder.create({data:{venueId:dto.venueId,currency:v.currency,moneyScale:isoMoneyScale(v.currency),createdById:user.id,customerId:dto.customerId,guestName:dto.guestName?.trim()||null,guestPhone:dto.guestPhone?guestPhoneForStorage(dto.guestPhone,v.countryCode):null}});
    });
  }
  /** Newest bills first (ids are random UUIDs, so they cannot order anything). `state:'open'` lists every unpaid/unclosed bill, however old; each row carries enough to recognise it: its stations, the guest, what is still owed. */
  async list(user:AuthenticatedUser,venueId:string,cursor?:string,state?:'open') {
    await this.commands.access(this.prisma,user,venueId,'orders.manage',false);
    await assertStaffAnyPermission(this.prisma,user,['reports.view','payments.record']);
    if(cursor&&!await this.prisma.gamingOrder.findFirst({where:{id:cursor,venueId}})) throw new ForbiddenException({code:'CURSOR_NOT_ACCESSIBLE'});
    const scope=user.roles.includes('staff')?await loadStaffScope(this.prisma,user.id):null;
    const customers=!user.roles.includes('staff')||user.roles.includes('owner')||user.roles.includes('admin')||scopeCan(scope,'customers.view');
    const rows=await this.prisma.gamingOrder.findMany({where:{venueId,...(state==='open'?{state:'open'}:{})},orderBy:[{createdAt:'desc'},{id:'desc'}],take:31,...(cursor?{cursor:{id:cursor},skip:1}:{}),
      select:{id:true,version:true,state:true,createdAt:true,currency:true,totalMinor:true,moneyScale:true,guestName:true,sessions:{select:{unitId:true,state:true,unit:{select:{name:true}},segments:{select:{unitId:true,unit:{select:{name:true}}},orderBy:{startedAt:'asc'}}},orderBy:{startedAt:'asc'}},payments:{where:{status:{in:['paid','refunded']}},select:{amount:true,moneyScale:true}}}});
    const items=rows.slice(0,30).map(({payments,sessions,moneyScale,guestName,...o})=>{
      const receivedMinor=payments.reduce((sum,p)=>sum+rescaleMoney(p.amount,p.moneyScale,moneyScale),0);
      // every station a bill moved through (for its label) and the ones it sits on now (for «unpaid on this station»)
      const stations=new Map<string,{id:string;name:string}>();
      for(const x of sessions){for(const g of x.segments)stations.set(g.unitId,{id:g.unitId,name:g.unit.name});stations.set(x.unitId,{id:x.unitId,name:x.unit.name});}
      return {...o,guestName:customers?guestName:null,receivedMinor,remainingMinor:Math.max(0,o.totalMinor-receivedMinor),running:sessions.some(x=>x.state==='running'),units:[...stations.values()],unitIds:[...new Set(sessions.map(x=>x.unitId))]};
    });
    return {items,nextCursor:rows.length>30?rows[29].id:null};
  }
  async detail(user:AuthenticatedUser,id:string) {
    const row=await this.prisma.gamingOrder.findUnique({where:{id},include:{lines:{orderBy:[{createdAt:'asc'},{id:'asc'}],include:{allocations:true}},sessions:{include:{segments:{orderBy:{startedAt:'asc'}}}},payments:{where:{status:{in:['paid','refunded']}}},receipts:{select:{id:true,kind:true,number:true,issuedAt:true}}}});
    if(!row) throw new ForbiddenException({code:'ORDER_NOT_ACCESSIBLE'});
    await this.commands.access(this.prisma,user,row.venueId,'orders.manage',false);
    await assertStaffAnyPermission(this.prisma,user,['reports.view','payments.record']);
    const scope=user.roles.includes('staff')?await loadStaffScope(this.prisma,user.id):null;
    const customers=!user.roles.includes('staff')||user.roles.includes('owner')||user.roles.includes('admin')||scopeCan(scope,'customers.view');
    const now=new Date(); const lines=row.lines.map(l=>l.kind==='time'?{...l,amountMinor:this.sessions.charge(row.sessions.find(s=>s.id===l.sourceId)!,now)}:l);
    const totalMinor=lines.reduce((sum,l)=>sum+(l.kind==='discount'?-1:1)*l.amountMinor,0);
    const receivedMinor=row.payments.reduce((s,p)=>s+rescaleMoney(p.amount,p.moneyScale,row.moneyScale),0);
    return {...row,payments:row.payments.map(p=>({...p,amount:rescaleMoney(p.amount,p.moneyScale,row.moneyScale)})),customerId:customers?row.customerId:null,guestName:customers?row.guestName:null,guestPhone:customers?row.guestPhone:null,lines,totalMinor,receivedMinor,remainingMinor:Math.max(0,totalMinor-receivedMinor),creditMinor:Math.max(0,receivedMinor-totalMinor),serverNow:now.toISOString()};
  }
  add(user:AuthenticatedUser,id:string,dto:ProductLineDto) {
    return this.commands.command(user,'orders.manage',`order.add:${id}`,dto,async(tx,now)=>{
      await this.enabled(tx,dto.venueId);
      const order=await this.commands.versionOrder(tx,dto.venueId,id,dto.expectedVersion);
      const p=await tx.gamingProduct.findFirst({where:{id:dto.productId,venueId:dto.venueId,active:true}});
      if(!p) throw new BadRequestException({code:'PRODUCT_UNAVAILABLE'});
      if(p.currency!==order.currency) throw new BadRequestException({code:'CURRENCY_MISMATCH'});
      if(p.priceMinor*dto.quantity>2147483647)throw new BadRequestException({code:'ORDER_AMOUNT_INVALID'});
      const line=await tx.gamingOrderLine.create({data:{orderId:id,kind:'product',sourceId:p.id,nameAr:p.nameAr,nameEn:p.nameEn,quantity:dto.quantity,unitPriceMinor:p.priceMinor,amountMinor:p.priceMinor*dto.quantity,snapshot:{priceMinor:p.priceMinor,stockTracked:p.stockTracked,sku:p.sku}}});
      await this.moveStock(tx,p.id,-dto.quantity,user.id,'sale',line.id,p.stockTracked);
      return this.sessions.refreshOrder(tx,id,now);
    });
  }
  private async moveStock(tx:Prisma.TransactionClient,productId:string,delta:number,actorId:string,reason:string,lineId:string,tracked:boolean) {
    if(!tracked||!delta)return;
    const p=await tx.gamingProduct.findUniqueOrThrow({where:{id:productId}});
    if(p.availableQuantity+delta<0) throw new ConflictException({code:'INSUFFICIENT_STOCK'});
    await tx.gamingStockMovement.create({data:{productId,delta,reason,orderLineId:lineId,createdById:actorId}});
    const updated=await tx.gamingProduct.update({where:{id:productId},data:{availableQuantity:{increment:delta},version:{increment:1}}});
    await this.commands.event(tx,p.venueId,p.id,updated.version,'product.availability_changed');
  }
  quantity(user:AuthenticatedUser,id:string,lineId:string,dto:QuantityDto) {
    return this.commands.command(user,'orders.manage',`order.quantity:${id}:${lineId}`,dto,async(tx,now)=>{
      const order=await this.commands.versionOrder(tx,dto.venueId,id,dto.expectedVersion);const line=order.lines.find(l=>l.id===lineId);
      if(!line||line.kind!=='product'||line.returnedQuantity)throw new BadRequestException({code:'LINE_NOT_EDITABLE'});
      if(line.unitPriceMinor*dto.quantity>2147483647)throw new BadRequestException({code:'ORDER_AMOUNT_INVALID'});
      if(line.allocations.length)throw new ConflictException({code:'PAID_LINE_REQUIRES_RETURN'});
      const snap=line.snapshot as {stockTracked:boolean};
      await this.moveStock(tx,line.sourceId!,line.quantity-dto.quantity,user.id,'quantity correction',lineId,snap.stockTracked);
      // Zero is an audited removal, retained as a returned line with zero amount.
      await tx.gamingOrderLine.update({where:{id:lineId},data:dto.quantity?{quantity:dto.quantity,amountMinor:line.unitPriceMinor*dto.quantity}:{amountMinor:0,returnedQuantity:line.quantity}});
      return this.sessions.refreshOrder(tx,id,now);
    });
  }
  returnLine(user:AuthenticatedUser,id:string,lineId:string,dto:ReturnLineDto) {
    return this.commands.command(user,'refunds.issue',`order.return:${id}:${lineId}`,dto,async(tx,now)=>{
      if(!dto.reason.trim())throw new BadRequestException({code:'REASON_REQUIRED'});
      const order=await this.commands.versionOrder(tx,dto.venueId,id,dto.expectedVersion,true);const line=order.lines.find(l=>l.id===lineId);
      await tx.gamingOrder.update({where:{id},data:{state:'open'}});
      if(!line||line.kind!=='product'||dto.quantity>line.quantity-line.returnedQuantity)throw new BadRequestException({code:'RETURN_QUANTITY_INVALID'});
      const snap=line.snapshot as {stockTracked:boolean};
      if(dto.restock)await this.moveStock(tx,line.sourceId!,dto.quantity,user.id,dto.reason,lineId,snap.stockTracked);
      await tx.gamingOrderLine.update({where:{id:lineId},data:{returnedQuantity:{increment:dto.quantity},amountMinor:{decrement:dto.quantity*line.unitPriceMinor}}});
      return this.sessions.refreshOrder(tx,id,now);
    });
  }
  discount(user:AuthenticatedUser,id:string,dto:DiscountOrderDto) {
    return this.commands.command(user,'discounts.apply',`order.discount:${id}`,dto,async(tx,now)=>{
      if(!dto.reason.trim())throw new BadRequestException({code:'REASON_REQUIRED'});
      await this.commands.versionOrder(tx,dto.venueId,id,dto.expectedVersion);
      await this.sessions.refreshOrder(tx,id,now);
      const order=await tx.gamingOrder.findUniqueOrThrow({where:{id},include:{lines:{include:{allocations:true}},payments:{where:{status:{in:['paid','refunded']}}}}});
      const received=order.payments.reduce((s,p)=>s+rescaleMoney(p.amount,p.moneyScale,order.moneyScale),0);
      const eligible=order.lines.filter(l=>l.kind!=='booking-time').reduce((sum,l)=>sum+(l.kind==='discount'?-1:1)*l.amountMinor-l.allocations.reduce((s,a)=>s+a.amountMinor,0),0);
      if(dto.amountMinor>Math.min(order.totalMinor-received,eligible))throw new BadRequestException({code:'DISCOUNT_TOO_HIGH'});
      await tx.gamingOrderLine.create({data:{orderId:id,kind:'discount',nameAr:'خصم',nameEn:'Discount',quantity:1,unitPriceMinor:dto.amountMinor,amountMinor:dto.amountMinor,snapshot:{reason:dto.reason}}});
      return this.sessions.refreshOrder(tx,id,now);
    });
  }
  collect(user:AuthenticatedUser,id:string,dto:CollectOrderDto) {
    return this.commands.command(user,'payments.record',`order.collect:${id}`,dto,async(tx,now)=>{
      await assertStaffPermission(tx as never,user,'orders.manage');
      await this.commands.versionOrder(tx,dto.venueId,id,dto.expectedVersion);
      await this.sessions.refreshOrder(tx,id,now);
      const order=await tx.gamingOrder.findUniqueOrThrow({where:{id},include:{lines:{orderBy:[{createdAt:'asc'},{id:'asc'}],include:{allocations:true}},payments:{where:{status:{in:['paid','refunded']}}}}});
      const received=order.payments.reduce((s,p)=>s+rescaleMoney(p.amount,p.moneyScale,order.moneyScale),0);
      if(dto.amountMinor>order.totalMinor-received)throw new BadRequestException({code:'OVERPAYMENT'});
      const chargeLines=order.lines.filter(l=>l.kind!=='discount');const discount=order.lines.filter(l=>l.kind==='discount').reduce((s,l)=>s+l.amountMinor,0);
      const reductions=allocatePayment(discount,chargeLines.map(l=>l.kind==='booking-time'?0:l.amountMinor));
      const outstanding=chargeLines.map((l,i)=>Math.max(0,l.amountMinor-reductions[i]-l.allocations.reduce((s,a)=>s+a.amountMinor,0)));
      let allocations:number[];
      if(dto.lineId){const index=chargeLines.findIndex(l=>l.id===dto.lineId);if(index<0||dto.amountMinor>outstanding[index])throw new BadRequestException({code:'LINE_OVERPAYMENT'});allocations=chargeLines.map((_,i)=>i===index?dto.amountMinor:0);}
      else allocations=allocatePayment(dto.amountMinor,outstanding);
      const linkedBookings=await tx.usageSession.findMany({where:{orderId:id,bookingId:{not:null}},include:{booking:true}});
      for(let i=0;i<chargeLines.length;i++)if(allocations[i]&&chargeLines[i].kind==='booking-time'){
        const linked=linkedBookings.find(s=>s.id===chargeLines[i].sourceId)?.booking;
        if(linked?.source==='platform'&&linked.paymentModeSnapshot==='online')throw new ForbiddenException({code:'EXTERNAL_PAYMENT_REQUIRED'});
      }
      const payment=await tx.payment.create({data:{gamingOrderId:id,amount:dto.amountMinor,moneyScale:order.moneyScale,currency:order.currency,method:dto.method,status:'paid',recordedByUserId:user.id,manualRequestKey:dto.requestKey}});
      for(let i=0;i<chargeLines.length;i++)if(allocations[i])await tx.gamingPaymentAllocation.create({data:{paymentId:payment.id,lineId:chargeLines[i].id,amountMinor:allocations[i]}});
      for(const s of linkedBookings)await this.sessions.syncBookingPayment(tx,s.bookingId!);
      const receipt=await this.receipts.issue(tx,id,payment.id,user.id);
      const running=await tx.usageSession.count({where:{orderId:id,state:'running'}});
      const result=await tx.gamingOrder.update({where:{id},data:{version:{increment:1},...(!running&&received+dto.amountMinor===order.totalMinor?{state:'settled'}:{})}});
      await this.commands.event(tx,dto.venueId,id,result.version,'payment.recorded');
      return {order:result,paymentId:payment.id,receiptId:receipt.id,receivedMinor:received+dto.amountMinor,remainingMinor:order.totalMinor-received-dto.amountMinor,serverNow:now.toISOString()};
    });
  }
  refund(user:AuthenticatedUser,id:string,dto:RefundOrderDto) {
    return this.commands.command(user,'refunds.issue',`order.refund:${id}`,dto,async(tx,now)=>{
      if(!dto.reason.trim())throw new BadRequestException({code:'REASON_REQUIRED'});
      await this.commands.versionOrder(tx,dto.venueId,id,dto.expectedVersion,true);
      await tx.gamingOrder.update({where:{id},data:{state:'open'}});
      const p=await tx.payment.findFirst({where:{id:dto.paymentId,gamingOrderId:id,status:'paid'},include:{allocations:true,receiptDocuments:true}});
      if(!p)throw new BadRequestException({code:'PAYMENT_NOT_ACCESSIBLE'});
      if(!p.recordedByUserId||p.providerRef)throw new ForbiddenException({code:'EXTERNAL_REFUND_REQUIRED'});
      const previous=await tx.payment.findMany({where:{OR:[{gamingReversesPaymentId:p.id},{reversesPaymentId:p.id}]}});
      const order=await tx.gamingOrder.findUniqueOrThrow({where:{id}});const remaining=rescaleMoney(p.amount,p.moneyScale,order.moneyScale)+previous.reduce((sum,x)=>sum+rescaleMoney(x.amount,x.moneyScale,order.moneyScale),0);const amount=dto.amountMinor??remaining;
      if(amount<=0||amount>remaining)throw new BadRequestException({code:'REFUND_TOO_HIGH'});
      const refunded=await tx.gamingPaymentAllocation.groupBy({by:['lineId'],where:{payment:{gamingReversesPaymentId:p.id}},_sum:{amountMinor:true}});
      const allocations=allocatePayment(amount,p.allocations.map(a=>a.amountMinor+(refunded.find(r=>r.lineId===a.lineId)?._sum.amountMinor??0)));
      const refund=await tx.payment.create({data:{bookingId:null,gamingOrderId:id,amount:-amount,moneyScale:order.moneyScale,currency:p.currency,method:p.method,status:'refunded',recordedByUserId:user.id,gamingReversesPaymentId:p.id,note:dto.reason,manualRequestKey:dto.requestKey}});
      for(let i=0;i<p.allocations.length;i++)if(allocations[i])await tx.gamingPaymentAllocation.create({data:{paymentId:refund.id,lineId:p.allocations[i].lineId,amountMinor:-allocations[i]}});
      for(const s of await tx.usageSession.findMany({where:{orderId:id,bookingId:{not:null}}}))await this.sessions.syncBookingPayment(tx,s.bookingId!);
      const receipt=await this.receipts.issue(tx,id,refund.id,user.id,'refund',p.receiptDocuments[0]?.id);
      const result=await this.sessions.refreshOrder(tx,id,now);return {order:result,paymentId:refund.id,receiptId:receipt.id};
    });
  }
  settle(user:AuthenticatedUser,id:string,dto:GamingVersionDto) {
    return this.commands.command(user,'orders.manage',`order.settle:${id}`,dto,async(tx,now)=>{
      const order=await this.commands.versionOrder(tx,dto.venueId,id,dto.expectedVersion,true);
      if(order.state==='voided')throw new BadRequestException({code:'ORDER_CLOSED'});
      if(order.state==='settled'){const saved=await tx.receiptDocument.findFirst({where:{orderId:id,kind:'settled-bill'}});const bill=saved??await this.receipts.issue(tx,id,null,user.id,'settled-bill');return {order,receiptId:bill.id};}
      if(order.sessions.some(s=>s.state==='running'))throw new ConflictException({code:'ORDER_HAS_RUNNING_SESSIONS'});
      await this.sessions.refreshOrder(tx,id,now);
      const fresh=await tx.gamingOrder.findUniqueOrThrow({where:{id}});
      const received=order.payments.reduce((s,p)=>s+rescaleMoney(p.amount,p.moneyScale,order.moneyScale),0);
      if(received!==fresh.totalMinor)throw new ConflictException({code:'ORDER_HAS_BALANCE'});
      const result=await tx.gamingOrder.update({where:{id},data:{state:'settled',version:{increment:1}}});
      const bill=await this.receipts.issue(tx,id,null,user.id,'settled-bill');return {order:result,receiptId:bill.id};
    });
  }
}
