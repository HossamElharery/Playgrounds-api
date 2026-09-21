import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { BookingsService } from '../../bookings/bookings.service';
import { assertVenueAccess } from '../../../common/access/owner-access';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.interface';

export const REQUEST_STATUSES = ['open', 'approved', 'declined', 'answered', 'closed'] as const;

const INCLUDE = {
  booking: {
    select: {
      id: true, code: true, slotStart: true, slotEnd: true, status: true, baseAmount: true,
      court: { select: { name: true } },
    },
  },
  venue: { select: { id: true, nameEn: true, nameAr: true, ownerId: true } },
} satisfies Prisma.PlatformBookingRequestInclude;

type Row = Prisma.PlatformBookingRequestGetPayload<{ include: typeof INCLUDE }>;

/**
 * Owner requests to change/cancel a Matchena booking, and the admin's decisions on them.
 * The owner can only ASK (and see the answer); cancelling, with its refund and ledger effects,
 * is an admin action that goes through the one existing cancellation path.
 */
@Injectable()
export class PlatformRequestsService {
  private readonly logger = new Logger(PlatformRequestsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly bookings: BookingsService,
  ) {}

  /** Recorded by `OwnerBookingsService.requestPlatformChange` next to its notification and audit entry. */
  async record(input: { bookingId: string; venueId: string; kind: 'cancel' | 'change'; reason: string; userId: string }) {
    const open = await this.prisma.platformBookingRequest.findFirst({
      where: { bookingId: input.bookingId, kind: input.kind, status: 'open' },
      select: { id: true },
    });
    if (open) return { id: open.id, duplicate: true };
    const row = await this.prisma.platformBookingRequest.create({
      data: {
        bookingId: input.bookingId,
        venueId: input.venueId,
        kind: input.kind,
        reason: input.reason,
        createdById: input.userId,
      },
    });
    return { id: row.id, duplicate: false };
  }

  // ---- owner side ---------------------------------------------------------

  async listForVenue(user: AuthenticatedUser, venueId: string) {
    await assertVenueAccess(this.prisma, user, venueId, { write: false });
    const rows = await this.prisma.platformBookingRequest.findMany({
      where: { venueId },
      include: INCLUDE,
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return rows.map((r) => this.ownerDto(r));
  }

  // ---- admin side ---------------------------------------------------------

  async listAdmin(q: { status?: string; venueId?: string }) {
    const rows = await this.prisma.platformBookingRequest.findMany({
      where: {
        ...(q.status && (REQUEST_STATUSES as readonly string[]).includes(q.status) ? { status: q.status } : {}),
        ...(q.venueId ? { venueId: q.venueId } : {}),
      },
      include: INCLUDE,
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      take: 200,
    });
    const counts = await this.prisma.platformBookingRequest.groupBy({ by: ['status'], _count: { _all: true } });
    return {
      counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])),
      items: rows.map((r) => this.adminDto(r)),
    };
  }

  /** Cancel the booking (refund + ledger handled by the existing admin cancellation) and close the request as approved. */
  async approveCancel(adminId: string, id: string, reply?: string) {
    const req = await this.loadOpen(id);
    if (req.kind !== 'cancel') throw new BadRequestException('Only a cancellation request can be approved this way');
    if (['held', 'confirmed'].includes(req.booking.status)) {
      // The cancellation itself is guarded by the booking status, so a double click cannot refund twice.
      await this.bookings.cancelByAdmin(adminId, req.bookingId, reply?.trim() || req.reason);
    }
    return this.finish(adminId, req, 'approved', reply);
  }

  async decline(adminId: string, id: string, reply: string) {
    if (!reply?.trim()) throw new BadRequestException('A reason is required to decline');
    return this.finish(adminId, await this.loadOpen(id), 'declined', reply);
  }

  /** An answer with no action (e.g. "we contacted the player"). */
  async answer(adminId: string, id: string, reply: string) {
    if (!reply?.trim()) throw new BadRequestException('A reply is required');
    return this.finish(adminId, await this.loadOpen(id), 'answered', reply);
  }

  async close(adminId: string, id: string) {
    return this.finish(adminId, await this.loadOpen(id), 'closed', undefined);
  }

  // ---- internals ----------------------------------------------------------

  private async loadOpen(id: string): Promise<Row> {
    const req = await this.prisma.platformBookingRequest.findUnique({ where: { id }, include: INCLUDE });
    if (!req) throw new NotFoundException('Request not found');
    if (req.status !== 'open') throw new ConflictException({ code: 'REQUEST_ALREADY_RESOLVED', message: 'This request was already resolved' });
    return req;
  }

  private async finish(adminId: string, req: Row, status: 'approved' | 'declined' | 'answered' | 'closed', reply?: string) {
    // Claim it: only one admin's decision can win.
    const claimed = await this.prisma.platformBookingRequest.updateMany({
      where: { id: req.id, status: 'open' },
      data: { status, adminReply: reply?.trim() || null, resolvedById: adminId, resolvedAt: new Date() },
    });
    if (!claimed.count) throw new ConflictException({ code: 'REQUEST_ALREADY_RESOLVED', message: 'This request was already resolved' });
    await this.prisma.auditLogEntry.create({
      data: {
        actorUserId: adminId,
        action: `platform.request.${status}`,
        targetType: 'booking',
        targetId: req.bookingId,
        metadata: { requestId: req.id, venueId: req.venueId, kind: req.kind } as Prisma.InputJsonValue,
      },
    });
    const wordsAr = { approved: 'اتقبل', declined: 'اترفض', answered: 'اتردّ عليه', closed: 'اتقفل' }[status];
    const wordsEn = { approved: 'approved', declined: 'declined', answered: 'answered', closed: 'closed' }[status];
    await this.notifications
      .create({
        userId: req.venue.ownerId,
        category: 'system',
        titleAr: `طلبك بخصوص الحجز ${req.booking.code} ${wordsAr}`,
        titleEn: `Your request about booking ${req.booking.code} was ${wordsEn}`,
        bodyAr: reply?.trim() || undefined,
        bodyEn: reply?.trim() || undefined,
        deepLink: '/owner/bookings',
        payload: { kind: 'platform_request_resolved', requestId: req.id, status },
      })
      .catch((err) => this.logger.warn(`request notice failed: ${String(err)}`));
    return { ok: true, status };
  }

  private ownerDto(r: Row) {
    return {
      id: r.id,
      kind: r.kind,
      reason: r.reason,
      status: r.status,
      adminReply: r.adminReply,
      createdAt: r.createdAt.toISOString(),
      resolvedAt: r.resolvedAt?.toISOString() ?? null,
      booking: { id: r.booking.id, code: r.booking.code, startsAt: r.booking.slotStart.toISOString(), courtName: r.booking.court.name, status: r.booking.status },
    };
  }

  private adminDto(r: Row) {
    return {
      ...this.ownerDto(r),
      venue: { id: r.venue.id, nameEn: r.venue.nameEn, nameAr: r.venue.nameAr },
      booking: { ...this.ownerDto(r).booking, endsAt: r.booking.slotEnd.toISOString(), baseAmount: r.booking.baseAmount },
    };
  }
}
