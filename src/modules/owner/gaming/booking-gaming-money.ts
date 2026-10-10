import { rescaleMoney } from '../../../common/money/money-scale';
import { PaymentMethod, Prisma } from '@prisma/client';
/** Read projection only: one real order payment can allocate to several bookings. */
export const GAMING_BOOKING_MONEY_SELECT={id:true,orderId:true,order:{select:{moneyScale:true,payments:{where:{bookingId:null,status:{in:['paid','refunded']}},select:{id:true,amount:true,method:true,createdAt:true,recordedByUserId:true,reversesPaymentId:true,shiftId:true,note:true,allocations:{select:{amountMinor:true,line:{select:{kind:true,sourceId:true}}}}}}}}} satisfies Prisma.UsageSessionSelect;
type SessionMoney=Prisma.UsageSessionGetPayload<{select:typeof GAMING_BOOKING_MONEY_SELECT}>;
export function gamingBookingPayments(session:SessionMoney|null|undefined){
 if(!session)return [];
 return session.order.payments.map(p=>({...p,amount:p.allocations.filter(a=>a.line.kind==='booking-time'&&a.line.sourceId===session.id).reduce((sum,a)=>sum+rescaleMoney(a.amountMinor,session.order.moneyScale,100),0)})).filter(p=>p.amount!==0);
}
