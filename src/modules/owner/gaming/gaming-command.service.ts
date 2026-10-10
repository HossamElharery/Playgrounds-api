import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { assertStaffPermission, assertVenueAccess } from '../../../common/access/owner-access';
import { PermissionKey } from '../../../common/access/permissions';
import { AuthenticatedUser } from '../../../common/types/authenticated-user.interface';
import { PrismaService } from '../../prisma/prisma.service';
import { rethrowConcurrentWrite } from '../../../common/utils/transaction-error.util';
import { GamingCommandDto } from './gaming-operations.dto';
import { loadStaffScope, scopeCan } from '../../../common/access/staff-scope';
export const jsonValue = (v: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(v));
const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a],[b]) => a.localeCompare(b)).map(([k,x]) => [k,canonical(x)])) : v;
@Injectable()
export class GamingCommandService {
  constructor(readonly prisma: PrismaService) {}
  async access(db: Prisma.TransactionClient | PrismaService, user: AuthenticatedUser, venueId: string, permission: PermissionKey, write: boolean, allowSports=false) {
    const venue = await assertVenueAccess(db as PrismaService, user, venueId, { write });
    await assertStaffPermission(db as PrismaService, user, permission);
    if (write && (venue.status !== 'active' || !venue.approvedAt)) throw new ForbiddenException({ code: 'VENUE_NOT_APPROVED' });
    if(write){const application=await db.partnerApplication.findUnique({where:{venueId},select:{status:true}});if(application&&application.status!=='approved')throw new ForbiddenException({code:'VENUE_NOT_APPROVED'});}
    // A brand-new gaming venue has declared its activities but has no devices yet; it must still be able to create the first one.
    const gamingKinds = { in: ['gaming-station','table-game'] };
    const gaming = await db.court.findFirst({ where: { venueId, sport: { activityKind: gamingKinds } }, select: { id: true } })
      ?? await db.venueSport.findFirst({ where: { venueId, sport: { activityKind: gamingKinds } }, select: { venueId: true } });
    if (!gaming&&!allowSports) throw new ForbiddenException({ code: 'GAMING_NOT_AVAILABLE' });
    return venue;
  }
  async command<T>(user: AuthenticatedUser, permission: PermissionKey, operation: string, dto: GamingCommandDto, work: (tx: Prisma.TransactionClient, now: Date) => Promise<T>,allowSports=false): Promise<T> {
    await this.access(this.prisma, user, dto.venueId, permission, true,allowSports);
    const hash = createHash('sha256').update(JSON.stringify(canonical({ operation, dto: { ...dto, ...('startMode' in dto && dto.startMode === 'now' ? {startsAt:'server-now'} : {}) } }))).digest('hex');
    try {
      const result = await this.prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM "Venue" WHERE id=${dto.venueId} FOR UPDATE`;
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${dto.venueId},91005))::text`;
        await this.access(tx, user, dto.venueId, permission, true,allowSports);
        const key = { venueId: dto.venueId, actorId: user.id, requestKey: dto.requestKey.toLowerCase() };
        const previous = await tx.gamingCommand.findUnique({ where: { venueId_actorId_requestKey: key } });
        if (previous) {
          if (previous.requestHash !== hash) throw new ConflictException({ code: 'OPERATION_KEY_REUSED' });
          return previous.response as T;
        }
        const [{ now }] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now`;
        const result = await work(tx, now);
        const response = jsonValue(result);
        await tx.gamingCommand.create({ data: { ...key, operation, requestHash: hash, response } });
        await tx.auditLogEntry.create({ data: { actorUserId: user.id, action: `owner.gaming.${operation}`, targetType: 'venue', targetId: dto.venueId, metadata: { requestKey: dto.requestKey } } });
        return response as T;
      }, { maxWait: 10000, timeout: 20000 });
      // Stored idempotent responses are historical; disclosure follows current access.
      await this.access(this.prisma,user,dto.venueId,permission,true,allowSports);
      if (!user.roles.includes('staff') || user.roles.includes('owner') || user.roles.includes('admin')) return result;
      const scope=await loadStaffScope(this.prisma,user.id);
      const money=scopeCan(scope,'reports.view')||scopeCan(scope,'payments.record')||permission==='receipts.print'||permission==='printer.manage'||permission==='products.manage'||permission==='pricing.manage';
      const customers=scopeCan(scope,'customers.view');
      const redact=(value:unknown):unknown=>Array.isArray(value)?value.map(redact):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([key])=>
        (customers||!['customerId','customer','guestName','guestPhone'].includes(key))&&
        (money||!(/Minor$/.test(key)||['amount','totalAmount','baseAmount','priceAmount','payments','allocations','lines','segments','snapshot','rateSnapshot'].includes(key)))
      ).map(([key,item])=>[key,redact(item)])):value;
      return redact(result) as T;
    } catch (error) { rethrowConcurrentWrite(error); }
  }
  async event(tx: Prisma.TransactionClient, venueId: string, entityId: string, version: number|null, type: string) {
    if(version===null){const last=await tx.gamingOutbox.aggregate({where:{venueId,entityId,type},_max:{version:true}});version=(last._max.version??0)+1;}
    await tx.gamingOutbox.create({ data: { venueId, entityId, version, type } });
  }
  async versionOrder(tx: Prisma.TransactionClient, venueId: string, orderId: string, version: number, allowClosed = false) {
    const order = await tx.gamingOrder.findFirst({ where: { id: orderId, venueId }, include: { lines: { orderBy: [{ createdAt: 'asc' },{ id: 'asc' }], include: { allocations: true } }, payments: { where: { status: { in: ['paid','refunded'] } } }, sessions: true } });
    if (!order) throw new ForbiddenException({ code: 'ORDER_NOT_ACCESSIBLE' });
    if (order.version !== version) throw new ConflictException({ code: 'ORDER_VERSION_CONFLICT', latestVersion: order.version });
    if (order.state !== 'open' && !allowClosed) throw new BadRequestException({ code: 'ORDER_CLOSED' });
    return order;
  }
}
