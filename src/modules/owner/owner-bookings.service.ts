import { GAMING_BOOKING_MONEY_SELECT,gamingBookingPayments } from './gaming/booking-gaming-money';
import { assertActivityDuration, usesMinuteTiming } from '../../common/utils/activity-timing.util';
import { rethrowConcurrentWrite } from '../../common/utils/transaction-error.util';
import { isSafeReceiptUrl } from '../../common/utils/receipt-url.util';
import { hasOpeningHours } from '../../common/utils/venue-readiness.util';
import {
  BadRequestException,
  ConflictException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Booking, PaymentMethod, PaymentStatus, Prisma } from '@prisma/client';
import { randomBytes } from 'crypto';
import { manualBookingHash, offlineTokenHash } from './offline/offline-policy';
import { loadStaffScope, scopeCan } from '../../common/access/staff-scope';
import { PlatformRequestsService } from './requests/platform-requests.service';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { assertSlotNotInPast } from '../../common/utils/past-slot.util';
import { LedgerService } from '../finance/ledger.service';
import { CommissionService } from '../finance/commission.service';
import { NotificationsService } from '../notifications/notifications.service';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.interface';
import {
  assertBookingAccess,
  assertStaffPermission,
  assertStaffAnyPermission,
  assertVenueAccess,
} from '../../common/access/owner-access';
import { ApiException } from '../../common/errors/api-exception';
import { isBookingSlotConflict } from '../../common/utils/booking-slot-conflict.util';
import { maskPlayerPhone } from '../../common/utils/phone.util';
import { guestPhoneForStorage, phoneSearchNeedle } from '../../common/utils/guest-phone.util';
import { quoteDurationPrice } from '../../common/utils/price-quote.util';
import {
  assertCustomSourceLabel,
  isPresetSourceKey,
  normalizeSourceLabel,
  SOURCE_PRESETS,
  sourceDisplay,
} from '../../common/utils/source-label.util';
import { zonedDayBounds, zonedHhmm, zonedWeekday } from '../../common/utils/timezone.util';
import { zonedYmd } from '../../common/utils/owner-range.util';
import {
  isTimeWithinDayHours,
  type WeeklyHours,
} from '../../common/utils/weekly-hours.util';
import {
  CreateManualBookingDto,
  UpdateManualBookingDto,
  OwnerOfflineEventDto,
} from './dto/manual-booking.dto';
import { CreateWalkInDto } from './dto/walk-in.dto';
import { formatMoney, notifyFinance } from '../finance/finance-notify';
import { buildBookingStatement } from '../../common/money/booking-statement';
import { COUNTED_PAYMENT_STATUSES, derivePaymentStatus, netOf, netReceived } from './cash/payment-trail';

const NINETY_DAYS_MS = 90 * 86_400_000;

export type CancelReason = 'customer_request' | 'venue_issue' | 'duplicate' | 'other';

function mapPaymentMethod(
  method?: string,
): PaymentMethod {
  if (method === 'instapay' || method === 'wallet' || method === 'card' || method === 'cash' || method === 'fawry') {
    return method;
  }
  // "Other" is never cash: a mislabelled payment must not inflate the money the drawer should hold.
  if (method === 'other') return 'wallet';
  return 'cash';
}

function mapPaymentStatus(
  status?: 'paid' | 'unpaid' | 'partial',
): PaymentStatus {
  if (status !== 'paid' && status !== 'partial') return 'pending';
  if (status === 'partial') return 'partial';
  return 'paid';
}

function generateManualCode(): string {
  return `MAN-${randomBytes(5).toString('hex').slice(0, 8).toUpperCase()}`;
}

@Injectable()
export class OwnerBookingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly commission: CommissionService,
    private readonly notifications: NotificationsService,
    private readonly email?: EmailService,
    private readonly requests?: PlatformRequestsService,
  ) {}

  async offlineOperationOutcome(user: AuthenticatedUser, key: string, kind: string) {
    key = key.toLowerCase();
    if (kind === 'create') return this.offlineBookingOutcome(user, key);
    let bookingId: string | null = null;
    if (kind === 'payment') {
      const payment = await this.prisma.payment.findUnique({ where: { manualRequestKey: key } });
      if (payment?.recordedByUserId === user.id) bookingId = payment.bookingId;
    } else if (kind === 'attendance' || kind === 'note') {
      const event = await this.prisma.auditLogEntry.findUnique({ where: { id: key } });
      if (event?.actorUserId === user.id && event.action === `owner.offline.${kind}`) bookingId = event.targetId;
    } else throw new BadRequestException('Unknown operation kind');
    if (!bookingId) return { booking: null };
    await assertBookingAccess(this.prisma, user, bookingId, { write: false });
    return { booking: await this.getBooking(user, bookingId) };
  }

  async offlineBookingOutcome(user: AuthenticatedUser, requestKey: string) {
    const booking = await this.prisma.booking.findUnique({ where: { manualRequestKey: requestKey.toLowerCase() } });
    if (!booking) return { booking: null };
    if (booking.createdByUserId !== user.id) throw new NotFoundException('Operation not found');
    await assertBookingAccess(this.prisma, user, booking.id, { write: false });
    return { booking: await this.toOwnerBookingDto(booking, user) };
  }

  async recordOfflineEvent(user: AuthenticatedUser, dto: OwnerOfflineEventDto) {
    dto = { ...dto, requestKey: dto.requestKey.toLowerCase() };
    const { booking } = await assertBookingAccess(this.prisma, user, dto.bookingId, { write: true });
    await assertStaffPermission(this.prisma, user, dto.kind === 'attendance' ? 'bookings.checkin' : 'bookings.edit');
    const hash = offlineTokenHash(JSON.stringify({ bookingId: dto.bookingId, kind: dto.kind, note: dto.note?.trim() || null }));
    const replay = async () => {
      const event = await this.prisma.auditLogEntry.findUnique({ where: { id: dto.requestKey } });
      if (!event) return false;
      const meta = event.metadata as Record<string, unknown>;
      if (event.actorUserId !== user.id || meta?.requestHash !== hash) throw new ConflictException({ code: 'OPERATION_KEY_REUSED', message: 'Operation identity changed' });
      return true;
    };
    if (await replay()) return this.toOwnerBookingDto(booking, user);
    if (booking.source !== 'manual') throw new BadRequestException('Offline events apply only to manual bookings');
    if (dto.kind === 'note' && !dto.note?.trim()) throw new BadRequestException('Note is required');
    try {
      await this.prisma.$transaction(async tx => {
        const current = await tx.booking.findUniqueOrThrow({ where: { id: dto.bookingId } });
        if (!['confirmed', 'completed'].includes(current.status)) throw new ConflictException('Booking is no longer active');
        if (dto.kind === 'attendance') {
          if (current.slotStart.getTime() > Date.now() + 15 * 60_000) throw new ConflictException('Attendance cannot be recorded before the booking');
          if (!current.checkedInAt) await tx.booking.update({ where: { id: current.id }, data: { checkedInAt: new Date(), checkedInByUserId: user.id, status: 'completed' } });
        } else {
          const notes = [current.notes, dto.note?.trim()].filter(Boolean).join('\n');
          if (notes.length > 10_000) throw new BadRequestException('Booking notes limit reached');
          await tx.booking.update({ where: { id: current.id }, data: { notes } });
        }
        await tx.auditLogEntry.create({ data: { id: dto.requestKey, actorUserId: user.id,
          action: `owner.offline.${dto.kind}`, targetType: 'booking', targetId: current.id,
          metadata: { requestHash: hash, venueId: current.venueId, note: dto.note ?? null, noAutomaticCollection: true } } });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) { if (!(await replay())) rethrowConcurrentWrite(error); }
    return this.getBooking(user, dto.bookingId);
  }

  async prepareOffline(user: AuthenticatedUser, venueId: string, deviceId: string) {
    await assertVenueAccess(this.prisma, user, venueId, { write: true });
    await assertStaffPermission(this.prisma, user, 'bookings.create');
    const scope = await loadStaffScope(this.prisma, user.id);
    const now = new Date();
    const token = randomBytes(32).toString('hex');
    const grant = await this.prisma.ownerOfflineGrant.create({ data: {
      tokenHash: offlineTokenHash(token), userId: user.id, venueId, deviceId,
      cashAllowed: user.roles.includes('owner') || user.roles.includes('admin') || scopeCan(scope, 'payments.record'),
      issuedAt: now, expiresAt: new Date(now.getTime() + 24 * 3600_000),
      replayUntil: new Date(now.getTime() + 30 * 86400_000),
      horizonEnd: new Date(now.getTime() + 7 * 86400_000),
    } });
    return { token, venueId, deviceId, cashAllowed: grant.cashAllowed,
      issuedAt: grant.issuedAt.toISOString(), expiresAt: grant.expiresAt.toISOString(),
      replayUntil: grant.replayUntil.toISOString(), horizonEnd: grant.horizonEnd.toISOString() };
  }

  private async manualReplay(user: AuthenticatedUser, dto: CreateManualBookingDto) {
    if (!dto.requestKey) return null;
    const previous = await this.prisma.booking.findUnique({ where: { manualRequestKey: dto.requestKey } });
    if (!previous) return null;
    if (previous.createdByUserId !== user.id || previous.venueId !== dto.venueId ||
        previous.manualRequestHash !== manualBookingHash(dto)) {
      throw new ConflictException({ code: 'OPERATION_KEY_REUSED', message: 'Operation identity does not match its original booking' });
    }
    return { ...(await this.toOwnerBookingDto(previous, user)), warnings: [] };
  }

  async createManualBooking(
    user: AuthenticatedUser,
    dto: CreateManualBookingDto,
  ) {
    dto = { ...dto, requestKey: dto.requestKey?.toLowerCase() };
    const venue = await assertVenueAccess(this.prisma, user, dto.venueId, {
      write: true,
    });
    await assertStaffPermission(this.prisma, user, 'bookings.create');
    if (dto.paymentStatus === 'paid' || dto.paymentStatus === 'partial' || (dto.paidAmount ?? 0) > 0) {
      await assertStaffPermission(this.prisma, user, 'payments.record');
    }
    if (!Number.isSafeInteger(dto.priceAmount) || dto.priceAmount < 0 || dto.priceAmount > 10_000_000 ||
        !Number.isInteger(dto.durationMinutes) || dto.durationMinutes < 1 || dto.durationMinutes > 720 ||
        (dto.startMode !== 'now' && !Number.isFinite(new Date(dto.startsAt).getTime())) ||
        (dto.paidAmount != null && (!Number.isSafeInteger(dto.paidAmount) || dto.paidAmount <= 0 || dto.paidAmount > dto.priceAmount))) {
      throw new BadRequestException('Invalid booking amount, time or duration');
    }
    if (dto.startMode === 'now' && (dto.offlineGrant || !dto.requestKey)) throw new BadRequestException('Now requires an online idempotent request');
    const replay = await this.manualReplay(user, dto);
    if (replay) return replay;
    if (dto.offlineGrant) {
      if (!dto.requestKey) throw new BadRequestException('Offline bookings require a request key');
      const grant = await this.prisma.ownerOfflineGrant.findUnique({ where: { tokenHash: offlineTokenHash(dto.offlineGrant) } });
      const start = new Date(dto.startsAt).getTime();
      const end = start + dto.durationMinutes * 60_000;
      if (!grant || grant.userId !== user.id || grant.venueId !== dto.venueId ||
          grant.replayUntil.getTime() < Date.now() || start < grant.issuedAt.getTime() - 15 * 60_000 ||
          end > grant.horizonEnd.getTime()) {
        throw new ConflictException({ code: 'OFFLINE_GRANT_INVALID', message: 'Offline booking needs review: authorization or date range is invalid' });
      }
      if ((dto.paymentStatus === 'paid' || dto.paymentStatus === 'partial') &&
          (!grant.cashAllowed || (dto.paymentMethod ?? 'cash') !== 'cash')) {
        throw new BadRequestException('Only authorized cash collections are available offline');
      }
    }
    if ((dto.paymentStatus ?? 'unpaid') === 'unpaid' && (dto.paidAmount ?? 0) > 0) {
      throw new BadRequestException('An unpaid booking cannot include a collection');
    }
    if (dto.paymentStatus === 'paid' && dto.paidAmount != null && dto.paidAmount !== dto.priceAmount) {
      throw new BadRequestException('A paid booking must collect its exact total');
    }
    // A schedule with no opening hours is not a schedule: refuse instead of offering 03:00.
    if (!hasOpeningHours(venue.weeklyHours)) {
      throw new ApiException(
        HttpStatus.CONFLICT,
        'VENUE_HOURS_REQUIRED',
        'Set the venue opening hours before adding bookings',
      );
    }
    const court = await this.prisma.court.findUnique({
      where: { id: dto.courtId },
      include: { sport: { select: { activityKind: true } } },
    });
    if (!court || court.venueId !== dto.venueId) {
      throw new BadRequestException('Court does not belong to this venue');
    }
    assertActivityDuration(dto.durationMinutes, court.sport.activityKind);
    if (dto.startMode === 'now' && (!usesMinuteTiming(court.sport.activityKind) || venue.status !== 'active' || !venue.approvedAt)) throw new BadRequestException('Now requires an approved gaming venue');
    let slotStart = dto.startMode === 'now' ? new Date() : new Date(dto.startsAt);
    let slotEnd = new Date(slotStart.getTime() + dto.durationMinutes * 60_000);
    if (!dto.offlineGrant) assertSlotNotInPast(slotStart);
    if (dto.paymentStatus === 'partial') {
      if (!dto.paidAmount || dto.paidAmount <= 0 || dto.paidAmount >= dto.priceAmount) {
        throw new BadRequestException('paidAmount is required and must be between 0 and priceAmount');
      }
    }
    let sourceKey = dto.sourceKey;
    let sourceLabel = dto.sourceLabel?.trim() || null;
    if (sourceLabel) {
      try {
        sourceLabel = assertCustomSourceLabel(sourceLabel);
      } catch {
        throw new BadRequestException('Invalid source label');
      }
    } else if (!sourceKey) {
      sourceKey = 'walk_in';
    }

    const warnings: string[] = [];
    const weeklyHours = venue.weeklyHours as WeeklyHours | null;
    const timeZone = await this.venueTz(dto.venueId);
    if (weeklyHours) {
      for (let t = slotStart.getTime(); t < slotEnd.getTime(); t += (usesMinuteTiming(court.sport.activityKind) ? 1 : 15) * 60_000) {
        const instant = new Date(t);
        const day = zonedWeekday(instant, timeZone);
        const hours = weeklyHours[String(day)] ?? weeklyHours[day as unknown as string];
        if (!isTimeWithinDayHours(zonedHhmm(instant, timeZone), hours)) {
          warnings.push('OUTSIDE_HOURS');
          break;
        }
      }
    }

    try {
      const booking = await this.prisma.$transaction(
        async (tx) => {
          if (dto.startMode === 'now') {
            await tx.$queryRaw`SELECT "id" FROM "Court" WHERE "id" = ${dto.courtId} FOR UPDATE`;
            const approved = await tx.venue.findUnique({ where: { id: dto.venueId } });
            if (approved?.status !== 'active' || !approved.approvedAt) throw new BadRequestException('Venue must be approved');
            slotStart = new Date();
            slotEnd = new Date(slotStart.getTime() + dto.durationMinutes * 60_000);
          }
          const created = await this.insertManualBooking(tx, {
            userId: user.id,
            requestKey: dto.requestKey,
            requestHash: dto.requestKey ? manualBookingHash(dto) : undefined,
            venueId: dto.venueId,
            courtId: dto.courtId,
            slotStart,
            slotEnd,
            priceAmount: dto.priceAmount,
            paymentStatus: dto.paymentStatus,
            paidAmount: dto.paidAmount,
            paymentMethod: dto.paymentMethod,
            customerName: dto.customerName,
            customerPhone: dto.customerPhone,
            sourceKey,
            sourceLabel,
            notes: dto.notes,
          });
          await tx.auditLogEntry.create({
            data: {
              actorUserId: user.id,
              action: 'owner.booking.created',
              targetType: 'booking',
              targetId: created.id,
              metadata: {
                bookingId: created.id,
                requestKey: dto.requestKey ?? null,
                offlineReplay: Boolean(dto.offlineGrant),
                venueId: dto.venueId,
                code: created.code,
                amount: dto.priceAmount,
                currency: created.currency,
                paymentStatus: dto.paymentStatus ?? 'unpaid',
                // What was taken at the desk while booking: the trail must show it as money, not hide it in the price.
                paid: dto.paymentStatus === 'paid' ? dto.priceAmount : dto.paymentStatus === 'partial' ? dto.paidAmount ?? 0 : 0,
                paymentMethod: dto.paymentMethod ?? 'cash',
                customer: dto.customerName?.trim() || null,
              } as Prisma.InputJsonValue,
            },
          });
          return created;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      return { ...(await this.toOwnerBookingDto(booking, user)), warnings, serverNow: new Date().toISOString() };
    } catch (error) {
      if (dto.requestKey) {
        const replay = await this.manualReplay(user, dto);
        if (replay) return replay;
      }
      if (error instanceof ConflictException || error instanceof ApiException) throw error;
      if (isBookingSlotConflict(error)) {
        throw new ConflictException({ code: 'SLOT_ALREADY_HELD', message: 'Slot already held' });
      }
      rethrowConcurrentWrite(error);
    }
  }

  /**
   * The one place a manual booking row (plus its first payment and ledger sync) is
   * written, shared by the single-booking flow and fixed-booking series so both apply
   * the same conflict check and payment rules. Runs inside the caller's transaction.
   */
  async insertManualBooking(
    tx: Prisma.TransactionClient,
    input: {
      userId: string;
      requestKey?: string;
      requestHash?: string;
      venueId: string;
      courtId: string;
      slotStart: Date;
      slotEnd: Date;
      priceAmount: number;
      paymentStatus?: 'paid' | 'unpaid' | 'partial';
      paidAmount?: number;
      paymentMethod?: string;
      customerName?: string | null;
      customerPhone?: string | null;
      sourceKey?: string;
      sourceLabel?: string | null;
      notes?: string | null;
      recurringSeriesId?: string;
      /** Who took the first payment. Defaults to `userId`; `null` for imported history (never in a drawer). */
      paymentRecordedBy?: string | null;
      /** When the first payment was taken (imports back-date it to the play date). */
      paidAt?: Date;
      importBatchId?: string;
    },
  ) {
    await this.assertSlotFree(tx, input.courtId, input.venueId, input.slotStart, input.slotEnd);
    // The booking is written in the venue's own currency — never the column default.
    const venueRow = await tx.venue.findUnique({ where: { id: input.venueId }, select: { currency: true, countryCode: true } });
    if (!venueRow) throw new NotFoundException('Venue not found');
    let code = generateManualCode();
    for (let i = 0; i < 5; i++) {
      const clash = await tx.booking.findUnique({ where: { code } });
      if (!clash) break;
      code = generateManualCode();
    }
    const paymentStatus = mapPaymentStatus(input.paymentStatus);
    const paymentMethod = mapPaymentMethod(input.paymentMethod);
    const { sourceLabel } = input;
    const created = await tx.booking.create({
      data: {
        code,
        manualRequestKey: input.requestKey,
        manualRequestHash: input.requestHash,
        courtId: input.courtId,
        venueId: input.venueId,
        userId: input.userId,
        slotStart: input.slotStart,
        slotEnd: input.slotEnd,
        currency: venueRow.currency,
        baseAmount: input.priceAmount,
        feeAmount: 0,
        discountAmount: 0,
        totalAmount: input.priceAmount,
        status: 'confirmed',
        paymentStatus,
        paymentMethod,
        guestName: input.customerName?.trim() || null,
        guestPhone: guestPhoneForStorage(input.customerPhone, venueRow.countryCode),
        source: 'manual',
        sourceKey: sourceLabel ? null : (input.sourceKey ?? 'walk_in'),
        sourceLabel: sourceLabel ?? null,
        notes: input.notes?.trim() || null,
        createdByUserId: input.userId,
        recurringSeriesId: input.recurringSeriesId ?? null,
        importBatchId: input.importBatchId ?? null,
      },
    });
    const paidNow =
      paymentStatus === 'paid'
        ? input.priceAmount
        : paymentStatus === 'partial'
          ? input.paidAmount!
          : 0;
    if (paidNow > 0) {
      await tx.payment.create({
        data: {
          bookingId: created.id,
          amount: paidNow,
          currency: created.currency,
          method: paymentMethod,
          status: 'paid',
          recordedByUserId: input.paymentRecordedBy === undefined ? input.userId : input.paymentRecordedBy,
          ...(input.paidAt ? { createdAt: input.paidAt } : {}),
        },
      });
    }
    if (sourceLabel) {
      await this.touchCustomSource(tx, input.venueId, sourceLabel);
    }
    await this.ledger.syncBookingLedger(tx, created.id);
    return created;
  }

  /** @deprecated thin alias of createManualBooking */
  async createWalkInAlias(user: AuthenticatedUser, dto: CreateWalkInDto) {
    const startsAt = new Date(dto.slotStart);
    const endsAt = new Date(dto.slotEnd);
    const durationMinutes = Math.max(
      15,
      Math.round((endsAt.getTime() - startsAt.getTime()) / 60_000 / 15) * 15,
    );
    return this.createManualBooking(user, {
      venueId: dto.venueId,
      courtId: dto.courtId,
      startsAt: dto.slotStart,
      durationMinutes,
      priceAmount: dto.priceAmount ?? 0,
      paymentStatus: 'paid',
      paymentMethod: 'cash',
      customerName: dto.customerName,
      customerPhone: dto.customerPhone,
      sourceKey: 'walk_in',
    });
  }

  /** One booking by id, for the owner sheet — no date guessing. */
  async getBooking(user: AuthenticatedUser, bookingId: string) {
    const booking = await this.prisma.booking.findUnique({ where: { id: bookingId } });
    if (!booking) throw new NotFoundException('Booking not found');
    await assertVenueAccess(this.prisma, user, booking.venueId, { write: false });
    return this.toOwnerBookingDto(booking, user);
  }

  async updateManualBooking(
    user: AuthenticatedUser,
    bookingId: string,
    dto: UpdateManualBookingDto,
  ) {
    const { booking } = await assertBookingAccess(this.prisma, user, bookingId, {
      write: true,
    });
    if (dto.paymentStatus !== undefined || dto.paidAmount !== undefined || dto.paymentMethod !== undefined) {
      await assertStaffPermission(this.prisma, user, 'payments.record');
    }
    if (booking.source === 'platform') {
      throw new ApiException(HttpStatus.FORBIDDEN, 'PLATFORM_BOOKING_LOCKED', 'Matchena bookings cannot be edited');
    }
    if (booking.status === 'cancelled') {
      throw new BadRequestException('Restore the booking before editing');
    }
    if (Date.now() - booking.slotStart.getTime() > NINETY_DAYS_MS) {
      throw new ApiException(HttpStatus.BAD_REQUEST, 'BOOKING_TOO_OLD', 'Bookings older than 90 days cannot be edited');
    }
    const courtId = dto.courtId ?? booking.courtId;
    const slotStart = dto.startsAt ? new Date(dto.startsAt) : booking.slotStart;
    const durationMinutes = dto.durationMinutes
      ?? Math.round((booking.slotEnd.getTime() - booking.slotStart.getTime()) / 60_000);
    const timedCourt = await this.prisma.court.findUnique({ where: { id: courtId }, include: { sport: { select: { activityKind: true } } } });
    if (!timedCourt || timedCourt.venueId !== booking.venueId) throw new BadRequestException('Court does not belong to this venue');
    assertActivityDuration(durationMinutes, timedCourt.sport?.activityKind);
    const slotEnd = new Date(slotStart.getTime() + durationMinutes * 60_000);
    // Money/notes on an old booking stay editable (e.g. recording a late payment);
    // moving it to a time that already passed is not.
    const moved =
      slotStart.getTime() !== booking.slotStart.getTime() ||
      slotEnd.getTime() !== booking.slotEnd.getTime() ||
      courtId !== booking.courtId;
    if (moved) assertSlotNotInPast(slotStart);
    if (dto.courtId) {
      const court = await this.prisma.court.findUnique({ where: { id: dto.courtId } });
      if (!court || court.venueId !== booking.venueId) {
        throw new BadRequestException('Court does not belong to this venue');
      }
    }

    const changed: Record<string, [unknown, unknown]> = {};
    const next: Prisma.BookingUpdateInput = {};
    const assign = (field: string, from: unknown, to: unknown, data: Prisma.BookingUpdateInput) => {
      if (JSON.stringify(from) !== JSON.stringify(to)) {
        changed[field] = [from, to];
        Object.assign(next, data);
      }
    };
    assign('courtId', booking.courtId, courtId, { court: { connect: { id: courtId } } });
    assign('slotStart', booking.slotStart.toISOString(), slotStart.toISOString(), { slotStart, slotEnd });
    if (dto.priceAmount != null) {
      assign('priceAmount', booking.totalAmount, dto.priceAmount, {
        baseAmount: dto.priceAmount,
        totalAmount: dto.priceAmount,
      });
    }
    if (dto.paymentMethod) {
      assign('paymentMethod', booking.paymentMethod, mapPaymentMethod(dto.paymentMethod), {
        paymentMethod: mapPaymentMethod(dto.paymentMethod),
      });
    }
    if (dto.customerName !== undefined) {
      assign('guestName', booking.guestName, dto.customerName, { guestName: dto.customerName });
    }
    if (dto.customerPhone !== undefined) {
      const country = (await this.prisma.venue.findUnique({ where: { id: booking.venueId }, select: { countryCode: true } }))?.countryCode;
      assign('guestPhone', booking.guestPhone, dto.customerPhone, {
        guestPhone: guestPhoneForStorage(dto.customerPhone, country ?? 'EG'),
      });
    }
    if (dto.notes !== undefined) assign('notes', booking.notes, dto.notes, { notes: dto.notes });
    let customLabel: string | undefined;
    if (dto.sourceLabel) {
      try {
        customLabel = assertCustomSourceLabel(dto.sourceLabel);
      } catch {
        throw new BadRequestException('Invalid source label');
      }
      assign('sourceLabel', booking.sourceLabel, customLabel, { sourceLabel: customLabel, sourceKey: null });
    } else if (dto.sourceKey) {
      assign('sourceKey', booking.sourceKey, dto.sourceKey, { sourceKey: dto.sourceKey, sourceLabel: null });
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const current = await tx.booking.findUniqueOrThrow({ where: { id: bookingId } });
      if (current.updatedAt && booking.updatedAt && current.updatedAt.getTime() !== booking.updatedAt.getTime()) {
        throw new ApiException(HttpStatus.CONFLICT, 'CONCURRENT_CHANGE', 'This booking changed. Refresh before editing it.');
      }
      await this.assertSlotFree(tx, courtId, booking.venueId, slotStart, slotEnd, booking.id);
      await this.reconcilePayment(tx, booking, dto, next, changed, user.id);
      const row = await tx.booking.update({ where: { id: bookingId }, data: next });
      if (customLabel) await this.touchCustomSource(tx, booking.venueId, customLabel);
      await tx.auditLogEntry.create({
        data: {
          actorUserId: user.id,
          action: 'owner.booking.updated',
          targetType: 'booking',
          targetId: bookingId,
          metadata: { bookingId, venueId: booking.venueId, changed } as Prisma.InputJsonValue,
        },
      });
      await this.ledger.syncBookingLedger(tx, bookingId);
      return row;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }).catch(rethrowConcurrentWrite);
    return this.toOwnerBookingDto(updated, user);
  }

  /**
   * Takes back one payment (the assistant's Undo, or a refund the owner hands over). Nothing is
   * deleted: a negative `refunded` row answers the original, so the cash drawer, the shift
   * history and the audit trail all stay true. The booking's status is re-derived from what
   * is left, exactly as `addManualPayment` derived it on the way in.
   *
   * A staff member can take back only their own payment that is still in their open drawer;
   * the owner (and anyone with `shifts.review`) can take back anybody's.
   */
  async voidManualPayment(
    user: AuthenticatedUser,
    bookingId: string,
    paymentId: string,
    reason?: string,
  ) {
    await assertStaffPermission(this.prisma, user, 'payments.record');
    const { booking } = await assertBookingAccess(this.prisma, user, bookingId, { write: true });
    if (booking.source === 'platform') {
      throw new ApiException(HttpStatus.FORBIDDEN, 'PLATFORM_BOOKING_LOCKED', 'Matchena bookings cannot take owner payments');
    }
    const canAll = await this.canManageEveryonesCash(user);
    await this.prisma.$transaction(
      async (tx) => {
        const current = await tx.booking.findUniqueOrThrow({ where: { id: bookingId } });
        const payment = await tx.payment.findFirst({
          where: { id: paymentId, bookingId, status: 'paid', amount: { gt: 0 } },
        });
        if (!payment) throw new NotFoundException('Payment not found');
        const already = await tx.payment.findUnique({ where: { reversesPaymentId: paymentId } });
        if (already) {
          throw new ApiException(HttpStatus.CONFLICT, 'PAYMENT_ALREADY_REVERSED', 'This payment was already taken back');
        }
        if (!canAll && !(payment.recordedByUserId === user.id && payment.shiftId == null)) {
          throw new ApiException(
            HttpStatus.FORBIDDEN,
            'PAYMENT_NOT_YOURS',
            'You can only take back a payment you recorded that is still in your open drawer',
          );
        }
        await tx.payment.create({
          data: {
            bookingId,
            amount: -payment.amount,
            currency: payment.currency,
            method: payment.method,
            status: 'refunded',
            reversesPaymentId: payment.id,
            // Same drawer as the original while that drawer is still open, so the two net out
            // there; once it was closed, the correction belongs to whoever hands the money back.
            recordedByUserId: payment.shiftId == null ? payment.recordedByUserId : user.id,
            note: reason?.trim() ? reason.trim().slice(0, 200) : null,
          },
        });
        const { received } = await netReceived(tx, bookingId);
        await tx.booking.update({
          where: { id: bookingId },
          data: { paymentStatus: derivePaymentStatus(current.totalAmount, received) },
        });
        await tx.auditLogEntry.create({
          data: {
            actorUserId: user.id,
            action: 'owner.booking.payment_voided',
            targetType: 'booking',
            targetId: bookingId,
            metadata: {
              bookingId,
              venueId: booking.venueId,
              paymentId,
              amount: payment.amount,
              method: payment.method,
              ...(reason?.trim() ? { reason: reason.trim().slice(0, 200) } : {}),
            } as Prisma.InputJsonValue,
          },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ).catch(rethrowConcurrentWrite);
    return this.toOwnerBookingDto(
      await this.prisma.booking.findUniqueOrThrow({ where: { id: bookingId } }),
      user,
    );
  }

  /** Owner, admin, or staff holding `shifts.review`. */
  private async canManageEveryonesCash(user: AuthenticatedUser): Promise<boolean> {
    if (user.roles.includes('admin') || user.roles.includes('owner')) return true;
    return scopeCan(await loadStaffScope(this.prisma, user.id), 'shifts.review');
  }

  /**
   * Cancels a manual booking. When money has already been received the caller must say what
   * happens to it (`settlement.refundAmount`): hand all of it back, none of it (the venue keeps
   * the deposit) or any amount in between. Nothing is silently kept or silently returned, and
   * every refund is a negative `refunded` row so the drawer, the cashbook and the audit trail
   * stay true. Venues differ — a padel club may refund a full day ahead, a billiards hall may
   * keep a deposit — so the policy is the owner's call, shown to them, never assumed.
   */
  async deleteManualBooking(
    user: AuthenticatedUser,
    bookingId: string,
    settlement?: { refundAmount?: number | 'all'; reason?: CancelReason },
  ) {
    const { booking } = await assertBookingAccess(this.prisma, user, bookingId, { write: true });
    if (booking.source === 'platform') {
      throw new ApiException(HttpStatus.FORBIDDEN, 'PLATFORM_BOOKING_LOCKED', 'Matchena bookings cannot be deleted');
    }
    const canAll = await this.canManageEveryonesCash(user);
    const updated = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.payment.findMany({
        where: { bookingId, status: { in: COUNTED_PAYMENT_STATUSES } },
        orderBy: { createdAt: 'asc' },
      });
      const { received } = netOf(rows);
      // `all` = hand back whatever was received (undoing a booking seconds after making it).
      const refundAmount = settlement?.refundAmount === 'all' ? Math.max(received, 0) : settlement?.refundAmount;
      if (received > 0 && refundAmount === undefined) {
        throw new ApiException(
          HttpStatus.CONFLICT,
          'PAYMENT_DECISION_REQUIRED',
          'This booking has money received: say how much to hand back (0 to keep it)',
        );
      }
      if (refundAmount !== undefined && (!Number.isSafeInteger(refundAmount) || refundAmount < 0 || refundAmount > Math.max(received, 0))) {
        throw new ApiException(HttpStatus.BAD_REQUEST, 'REFUND_EXCEEDS_RECEIVED', 'The refund cannot be more than the money received');
      }
      let handedBack = 0;
      if (refundAmount && refundAmount > 0) {
        // Walk the payments newest first so a partial refund comes out of the latest money.
        const reversed = new Set(rows.filter((r) => r.reversesPaymentId).map((r) => r.reversesPaymentId as string));
        const open = rows.filter((r) => r.amount > 0 && !reversed.has(r.id)).reverse();
        // Un-tied earlier refunds (partial ones) are netted per method, not per payment.
        const methodNet = new Map<string, number>();
        for (const r of rows) methodNet.set(r.method, (methodNet.get(r.method) ?? 0) + r.amount);
        let remaining = refundAmount;
        for (const row of open) {
          if (remaining <= 0) break;
          const room = Math.min(row.amount, methodNet.get(row.method) ?? 0);
          if (room <= 0) continue;
          const take = Math.min(room, remaining);
          if (!canAll && !(row.recordedByUserId === user.id && row.shiftId == null)) {
            throw new ApiException(
              HttpStatus.FORBIDDEN,
              'PAYMENT_NOT_YOURS',
              'You can only hand back money you recorded that is still in your open drawer',
            );
          }
          await tx.payment.create({
            data: {
              bookingId,
              amount: -take,
              currency: row.currency,
              method: row.method,
              status: 'refunded',
              // A whole payment taken back keeps the link (and can never be taken back twice).
              ...(take === row.amount ? { reversesPaymentId: row.id } : {}),
              recordedByUserId: row.shiftId == null ? row.recordedByUserId : user.id,
            },
          });
          methodNet.set(row.method, (methodNet.get(row.method) ?? 0) - take);
          remaining -= take;
          handedBack += take;
        }
      }
      const kept = Math.max(received - handedBack, 0);
      const row = await tx.booking.update({
        where: { id: bookingId },
        data: {
          status: 'cancelled',
          cancelledAt: new Date(),
          cancellationReason: 'deleted_by_owner',
          paymentStatus: derivePaymentStatus(booking.totalAmount, kept),
        },
      });
      await this.ledger.syncBookingLedger(tx, bookingId, 'cancelled');
      await tx.auditLogEntry.create({
        data: {
          actorUserId: user.id,
          action: 'owner.booking.cancelled',
          targetType: 'booking',
          targetId: bookingId,
          metadata: {
            bookingId,
            venueId: booking.venueId,
            code: booking.code,
            amount: booking.totalAmount,
            currency: booking.currency,
            customer: booking.guestName,
            refunded: handedBack,
            kept,
            ...(settlement?.reason ? { reason: settlement.reason } : {}),
          } as Prisma.InputJsonValue,
        },
      });
      return row;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }).catch(rethrowConcurrentWrite);
    return this.toOwnerBookingDto(updated, user);
  }

  async restoreManualBooking(user: AuthenticatedUser, bookingId: string) {
    const { booking } = await assertBookingAccess(this.prisma, user, bookingId, { write: true });
    if (booking.source === 'platform') {
      throw new ApiException(HttpStatus.FORBIDDEN, 'PLATFORM_BOOKING_LOCKED', 'Matchena bookings cannot be restored');
    }
    if (booking.status !== 'cancelled') {
      throw new BadRequestException('Only cancelled bookings can be restored');
    }
    if (booking.slotEnd.getTime() <= Date.now()) {
      throw new ApiException(HttpStatus.BAD_REQUEST, 'SLOT_IN_PAST', 'This time has already passed and cannot be restored');
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      const current = await tx.booking.findUniqueOrThrow({ where: { id: bookingId } });
      if (current.status !== 'cancelled') throw new BadRequestException('Only cancelled bookings can be restored');
      if (current.slotEnd.getTime() <= Date.now()) throw new ApiException(HttpStatus.BAD_REQUEST, 'SLOT_IN_PAST', 'This time has already passed and cannot be restored');
      await this.assertSlotFree(
        tx,
        current.courtId,
        current.venueId,
        current.slotStart,
        current.slotEnd,
        current.id,
      );
      const row = await tx.booking.update({
        where: { id: bookingId },
        data: { status: 'confirmed', cancelledAt: null, cancellationReason: null },
      });
      await this.ledger.syncBookingLedger(tx, bookingId);
      await tx.auditLogEntry.create({
        data: {
          actorUserId: user.id,
          action: 'owner.booking.restored',
          targetType: 'booking',
          targetId: bookingId,
          metadata: { bookingId, venueId: booking.venueId, code: booking.code, amount: booking.totalAmount, currency: booking.currency, customer: booking.guestName } as Prisma.InputJsonValue,
        },
      });
      return row;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }).catch(rethrowConcurrentWrite);
    return this.toOwnerBookingDto(updated, user);
  }

  async addManualPayment(
    user: AuthenticatedUser,
    bookingId: string,
    amount: number,
    method?: string,
    requestKey?: string,
  ) {
    await assertStaffPermission(this.prisma, user, 'payments.record');
    if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 100_000_000) {
      throw new ApiException(HttpStatus.BAD_REQUEST, 'INVALID_PAYMENT_AMOUNT', 'Payment must be a positive whole number of minor units');
    }
    const { booking } = await assertBookingAccess(this.prisma, user, bookingId, { write: true });
    if (booking.source === 'platform') {
      throw new ApiException(HttpStatus.FORBIDDEN, 'PLATFORM_BOOKING_LOCKED', 'Matchena bookings cannot take owner payments');
    }
    if (requestKey && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestKey)) {
      throw new ApiException(HttpStatus.BAD_REQUEST, 'INVALID_REQUEST_KEY', 'A collection request key must be a UUID v4');
    }
    requestKey = requestKey?.toLowerCase();
    const existingRequest = async (db: Pick<Prisma.TransactionClient, 'payment'>) => {
      if (!requestKey) return false;
      const existing = await db.payment.findUnique({ where: { manualRequestKey: requestKey } });
      if (!existing) return false;
      if (existing.bookingId !== bookingId || existing.recordedByUserId !== user.id || existing.amount !== amount || existing.method !== mapPaymentMethod(method)) {
        throw new ApiException(HttpStatus.CONFLICT, 'REQUEST_KEY_REUSED', 'This collection identity belongs to a different operation');
      }
      return true;
    };
    if (await existingRequest(this.prisma)) return this.toOwnerBookingDto(
      await this.prisma.booking.findUniqueOrThrow({ where: { id: bookingId } }), user);
    if (booking.status === 'cancelled') {
      throw new BadRequestException('Restore the booking before recording a payment');
    }
    await this.prisma.$transaction(
      async (tx) => {
        if (await existingRequest(tx)) return;
        const current = await tx.booking.findUniqueOrThrow({ where: { id: bookingId } });
        if (current.status === 'cancelled') throw new BadRequestException('Restore the booking before recording a payment');
        // Read inside the transaction so two quick taps cannot both pass the
        // "does not exceed the balance" check.
        const { received: already } = await netReceived(tx, bookingId);
        if (already + amount > current.totalAmount) {
          throw new ApiException(HttpStatus.BAD_REQUEST, 'OVERPAYMENT', 'Payment exceeds remaining balance');
        }
        const nextPaid = already + amount;
        const paymentStatus: PaymentStatus = derivePaymentStatus(current.totalAmount, nextPaid);
        await tx.payment.create({
          data: {
            bookingId,
            amount,
            currency: current.currency,
            method: mapPaymentMethod(method),
            status: 'paid',
            recordedByUserId: user.id,
            manualRequestKey: requestKey,
          },
        });
        await tx.booking.update({
          where: { id: bookingId },
          data: { paymentStatus, paymentMethod: mapPaymentMethod(method) },
        });
        await tx.auditLogEntry.create({
          data: {
            actorUserId: user.id,
            action: 'owner.booking.payment_recorded',
            targetType: 'booking',
            targetId: bookingId,
            metadata: { bookingId, venueId: booking.venueId, amount, method: mapPaymentMethod(method), remaining: current.totalAmount - nextPaid } as Prisma.InputJsonValue,
          },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ).catch(async error => {
      // A concurrent duplicate can lose the transaction race after the other request committed.
      if (requestKey && error instanceof Prisma.PrismaClientKnownRequestError && ['P2002', 'P2034'].includes(error.code) && await existingRequest(this.prisma)) return;
      rethrowConcurrentWrite(error);
    });
    return this.toOwnerBookingDto(
      await this.prisma.booking.findUniqueOrThrow({ where: { id: bookingId } }),
      user,
    );
  }

  /**
   * Keeps `paymentStatus` truthful after an edit. The status is always derived
   * from the payments actually recorded, so a booking can never read "paid"
   * while money is still owed (or the reverse).
   */
  private async reconcilePayment(
    tx: Prisma.TransactionClient,
    booking: Booking,
    dto: UpdateManualBookingDto,
    next: Prisma.BookingUpdateInput,
    changed: Record<string, [unknown, unknown]>,
    actorId: string,
  ) {
    const newTotal = dto.priceAmount ?? booking.totalAmount;
    let paid = (await netReceived(tx, booking.id)).received;
    if (paid > newTotal) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        'PRICE_BELOW_PAID',
        'The price cannot be lower than what was already paid',
      );
    }
    const requested = dto.paymentStatus;
    if (requested === 'unpaid' && paid > 0) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        'PAYMENT_ALREADY_RECORDED',
        'Money was already received on this booking',
      );
    }
    if (requested === 'partial' && !(paid > 0 && paid < newTotal)) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        'PARTIAL_NEEDS_PAYMENT',
        'Record a partial payment first',
      );
    }
    if (requested === 'paid' && paid < newTotal) {
      await tx.payment.create({
        data: {
          bookingId: booking.id,
          amount: newTotal - paid,
          currency: booking.currency,
          method: mapPaymentMethod(dto.paymentMethod ?? booking.paymentMethod ?? undefined),
          status: 'paid',
          recordedByUserId: actorId,
        },
      });
      paid = newTotal;
    }
    const status: PaymentStatus = derivePaymentStatus(newTotal, paid);
    if (status !== booking.paymentStatus) {
      changed.paymentStatus = [booking.paymentStatus, status];
      next.paymentStatus = status;
    }
  }

  /**
   * Matchena bookings belong to the player and to Matchena, so the venue cannot
   * cancel or reshape them itself. This is the sanctioned route: it tells the
   * admin (in-app + email) and leaves the booking untouched.
   */
  async requestPlatformChange(
    user: AuthenticatedUser,
    bookingId: string,
    dto: { kind: 'cancel' | 'change'; reason: string; urgent?: boolean },
  ) {
    const { booking } = await assertBookingAccess(this.prisma, user, bookingId, { write: true });
    if (booking.source !== 'platform') {
      throw new BadRequestException('Only Matchena bookings need an admin request');
    }
    if (booking.status !== 'confirmed' && booking.status !== 'held') {
      throw new BadRequestException('This booking is no longer active');
    }
    const reason = dto.reason?.trim() ?? '';
    if (reason.length < 5 || reason.length > 500) {
      throw new ApiException(HttpStatus.BAD_REQUEST, 'REASON_REQUIRED', 'Please explain the request (5–500 characters)');
    }
    const recent = await this.prisma.auditLogEntry.findFirst({
      where: {
        action: 'owner.booking.change_requested',
        targetId: bookingId,
        createdAt: { gte: new Date(Date.now() - 10 * 60_000) },
      },
      select: { id: true },
    });
    if (recent) return { ok: true, duplicate: true };
    const recorded = await this.requests?.record({
      bookingId,
      venueId: booking.venueId,
      kind: dto.kind,
      reason,
      userId: user.id,
    });
    if (recorded?.duplicate) return { ok: true, duplicate: true, requestId: recorded.id };

    const venue = await this.prisma.venue.findUnique({
      where: { id: booking.venueId },
      select: { nameEn: true, nameAr: true },
    });
    const tz = await this.venueTz(booking.venueId);
    const when = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(booking.slotStart);
    await this.prisma.auditLogEntry.create({
      data: {
        actorUserId: user.id,
        action: 'owner.booking.change_requested',
        targetType: 'booking',
        targetId: bookingId,
        metadata: { bookingId, venueId: booking.venueId, kind: dto.kind, reason, urgent: !!dto.urgent } as Prisma.InputJsonValue,
      },
    });

    const admins = await this.prisma.user.findMany({
      where: { roles: { has: 'admin' } },
      select: { id: true, email: true },
    });
    const verbEn = dto.kind === 'cancel' ? 'cancel' : 'change';
    const verbAr = dto.kind === 'cancel' ? 'إلغاء' : 'تعديل';
    const urgent = !!dto.urgent;
    const subject = `${urgent ? 'URGENT — ' : ''}Venue request: ${verbEn} booking ${booking.code}`;
    const body =
      `${venue?.nameEn ?? 'A venue'} asks to ${verbEn} Matchena booking ${booking.code} ` +
      `(${when}, ${tz}). Reason: ${reason}. ` +
      `— ${venue?.nameAr ?? ''} طلبت ${verbAr} الحجز ${booking.code}. السبب: ${reason}`;
    await Promise.all(
      admins.map(async (admin) => {
        await this.notifications
          .create({
            userId: admin.id,
            category: 'system',
            titleEn: subject,
            titleAr: `${urgent ? '🔴 عاجل — ' : ''}طلب ${verbAr} حجز ${booking.code} من ${venue?.nameAr ?? 'منشأة'}`,
            bodyEn: `${when} · ${reason}`,
            bodyAr: `${when} · ${reason}`,
            deepLink: '/admin/bookings',
            payload: { kind: 'booking_change_request', bookingId, venueId: booking.venueId, urgent },
          })
          .catch(() => undefined);
        if (admin.email && this.email) {
          await this.email.sendFinanceNotice(admin.email, subject, body).catch(() => undefined);
        }
      }),
    );
    return { ok: true, duplicate: false, requestId: recorded?.id };
  }

  async listSources(user: AuthenticatedUser, venueId: string) {
    await assertVenueAccess(this.prisma, user, venueId, { write: false });
    const custom = await this.prisma.venueBookingSource.findMany({
      where: { venueId },
      orderBy: [{ useCount: 'desc' }, { lastUsedAt: 'desc' }],
      take: 20,
    });
    return { presets: SOURCE_PRESETS, custom };
  }

  async deleteSource(user: AuthenticatedUser, venueId: string, id: string) {
    await assertVenueAccess(this.prisma, user, venueId, { write: true });
    const row = await this.prisma.venueBookingSource.findUnique({ where: { id } });
    if (!row || row.venueId !== venueId) throw new NotFoundException('Source not found');
    await this.prisma.venueBookingSource.delete({ where: { id } });
    return { ok: true };
  }

  async priceQuote(
    user: AuthenticatedUser,
    venueId: string,
    courtId: string,
    startsAt: string,
    durationMinutes: number,
  ) {
    await assertVenueAccess(this.prisma, user, venueId, { write: false });
    const court = await this.prisma.court.findUnique({
      where: { id: courtId },
      include: { sport: true, pricingRules: true, venue: { include: { country: true } } },
    });
    if (!court || court.venueId !== venueId) {
      throw new BadRequestException('Court does not belong to this venue');
    }
    assertActivityDuration(durationMinutes, court.sport?.activityKind);
    const tz = court.venue.country.timezone;
    const start = new Date(startsAt);
    if (!Number.isFinite(start.getTime())) throw new BadRequestException('Invalid start time');
    const quote = quoteDurationPrice(court.pricingRules, start, durationMinutes, tz, usesMinuteTiming(court.sport?.activityKind));
    const weeklyHours = court.venue.weeklyHours as WeeklyHours | null;
    const warnings: string[] = [];
    if (!hasOpeningHours(weeklyHours)) warnings.push('VENUE_HOURS_REQUIRED');
    else {
      for (let elapsed = 0; elapsed < durationMinutes; elapsed += (usesMinuteTiming(court.sport?.activityKind) ? 1 : 15)) {
        const instant = new Date(start.getTime() + elapsed * 60_000);
        const hours = weeklyHours![String(zonedWeekday(instant, tz))];
        if (!isTimeWithinDayHours(zonedHhmm(instant, tz), hours)) {
          warnings.push('OUTSIDE_HOURS');
          break;
        }
      }
    }
    return { ...quote, currency: court.venue.country.currency, warnings };
  }

  async listReportBookings(
    user: AuthenticatedUser,
    query: {
      venueId: string;
      from?: string;
      to?: string;
      source?: string;
      status?: string;
      courtId?: string;
      paymentStatus?: string;
      q?: string;
      cursor?: string;
      limit?: number;
      /** `upcoming` (nearest first), `today`, `past` (latest first), or `all` (latest first, the default). */
      scope?: string;
    },
  ) {
    await assertVenueAccess(this.prisma, user, query.venueId, { write: false });
    const limit = Math.min(query.limit ?? 30, 100);
    const where: Prisma.BookingWhereInput = { venueId: query.venueId };
    const scope = ['upcoming', 'today', 'past'].includes(query.scope ?? '') ? (query.scope as 'upcoming' | 'today' | 'past') : 'all';
    const venueRow = await this.prisma.venue.findUnique({
      where: { id: query.venueId },
      select: { country: { select: { timezone: true } } },
    });
    const tz = venueRow?.country?.timezone ?? 'Africa/Cairo';
    const now = new Date();
    const slotStart: Prisma.DateTimeFilter = {};
    // A plain calendar day ("2026-10-05") means that day on the VENUE's clock, not UTC midnight.
    const ymd = /^\d{4}-\d{2}-\d{2}$/;
    if (query.from) {
      if (ymd.test(query.from)) slotStart.gte = zonedDayBounds(query.from, tz).start;
      else slotStart.gte = new Date(query.from);
    }
    if (query.to) {
      if (ymd.test(query.to)) slotStart.lt = zonedDayBounds(query.to, tz).end;
      else slotStart.lte = new Date(query.to);
    }
    if (Object.keys(slotStart).length) where.slotStart = slotStart;
    if (scope === 'today') {
      const day = zonedDayBounds(zonedYmd(now, tz), tz);
      const today = { slotStart: { gte: day.start, lt: day.end } };
      if (where.slotStart) where.AND = [today];
      else where.slotStart = today.slotStart;
    } else if (scope === 'upcoming') {
      where.slotEnd = { gte: now };
    } else if (scope === 'past') {
      where.slotEnd = { lt: now };
    }
    if (query.status) where.status = query.status as Booking['status'];
    // The "what is coming" views are about real bookings: a cancelled one is found with its own filter.
    else if (scope === 'upcoming' || scope === 'today') where.status = { not: 'cancelled' };
    if (query.courtId) where.courtId = query.courtId;
    if (query.paymentStatus === 'owing') {
      // "Who still owes me": something unpaid or only partly paid, on a booking that still stands.
      where.paymentStatus = { in: ['pending', 'partial'] };
      if (!query.status) where.status = { in: ['confirmed', 'completed', 'held'] };
    } else if (query.paymentStatus) {
      if (!['pending', 'paid', 'failed', 'refunded', 'partial'].includes(query.paymentStatus)) {
        throw new BadRequestException('Unknown payment status');
      }
      where.paymentStatus = query.paymentStatus as Booking['paymentStatus'];
    }
    if (query.source === 'platform' || query.source === 'manual') {
      where.source = query.source;
    } else if (query.source && isPresetSourceKey(query.source)) {
      where.source = 'manual';
      where.sourceKey = query.source;
    } else if (query.source) {
      where.source = 'manual';
      where.sourceLabel = query.source;
    }
    const phonesVisible = await this.canSeePhones(user);
    if (query.q?.trim()) {
      const q = query.q.trim();
      // Searching by number would reveal it one digit at a time, so it needs the same right.
      where.OR = [
        { code: { contains: q, mode: 'insensitive' } },
        { guestName: { contains: q, mode: 'insensitive' } },
        ...(phonesVisible ? [{ guestPhone: { contains: phoneSearchNeedle(q) ?? q } }] : []),
      ];
    }
    const rows = await this.prisma.booking.findMany({
      where,
      include: {
        court: { include: { sport: { select: { activityKind: true, nameEn: true, nameAr: true } } } },
        user: { select: { id: true, name: true, phone: true } },
        venue:{select:{gamingReceiptsEnabled:true}},usageSession:{select:GAMING_BOOKING_MONEY_SELECT},
        payments: { where: { status: { in: COUNTED_PAYMENT_STATUSES } }, select: { amount: true } },
      },
      orderBy: scope === 'upcoming' || scope === 'today' ? [{ slotStart: 'asc' }, { id: 'asc' }] : [{ slotStart: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(query.cursor ? { skip: 1, cursor: { id: query.cursor } } : {}),
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      items: page.map((b) => (phonesVisible ? this.mapLoaded(b) : this.withoutPhone(this.mapLoaded(b)))),
      nextCursor: hasMore ? page[page.length - 1].id : undefined,
    };
  }

  async attention(user: AuthenticatedUser, venueId: string) {
    await assertStaffAnyPermission(this.prisma, user, ['payments.record', 'reports.view']);
    const phonesVisible = await this.canSeePhones(user);
    await assertVenueAccess(this.prisma, user, venueId, { write: false });
    const now = new Date();
    const windowStart = new Date(now.getTime() - 24 * 3_600_000);
    const needsArrival = await this.prisma.booking.findMany({
      where: {
        venueId,
        source: 'platform',
        status: 'confirmed',
        checkedInAt: null,
        slotEnd: { gte: windowStart, lte: now },
      },
      include: {
        court: { include: { sport: { select: { activityKind: true } } } },
        user: { select: { id: true, name: true, phone: true } },
        venue:{select:{gamingReceiptsEnabled:true}},usageSession:{select:GAMING_BOOKING_MONEY_SELECT},
        payments: { where: { status: { in: COUNTED_PAYMENT_STATUSES } }, select: { amount: true } },
      },
      orderBy: { slotEnd: 'asc' },
    });
    const unpaid = await this.prisma.booking.findMany({
      where: {
        venueId,
        source: 'manual',
        status: { not: 'cancelled' },
        paymentStatus: { in: ['pending', 'partial'] },
        slotStart: { gte: windowStart },
      },
      include: {
        court: { include: { sport: { select: { activityKind: true } } } },
        user: { select: { id: true, name: true, phone: true } },
        venue:{select:{gamingReceiptsEnabled:true}},usageSession:{select:GAMING_BOOKING_MONEY_SELECT},
        payments: { where: { status: { in: COUNTED_PAYMENT_STATUSES } }, select: { amount: true } },
      },
      orderBy: { slotStart: 'asc' },
    });
    return {
      arrival: needsArrival.map((b) => (phonesVisible ? this.mapLoaded(b) : this.withoutPhone(this.mapLoaded(b)))),
      unpaid: unpaid.map((b) => (phonesVisible ? this.mapLoaded(b) : this.withoutPhone(this.mapLoaded(b)))),
    };
  }

  async createRemittance(
    user: AuthenticatedUser,
    dto: {
      venueId: string;
      amount: number;
      method: string;
      reference?: string;
      note?: string;
      receiptUrl?: string;
    },
  ) {
    const venue = await assertVenueAccess(this.prisma, user, dto.venueId, { write: true });
    const currency = venue.currency;
    if (dto.receiptUrl && !isSafeReceiptUrl(dto.receiptUrl, process.env.S3_PUBLIC_BASE)) {
      throw new BadRequestException('receiptUrl must point to Matchena storage');
    }
    const settlement = await this.prisma.venueSettlement.create({
      data: {
        venueId: dto.venueId,
        direction: 'owner_to_platform',
        amount: dto.amount,
        currency,
        method: dto.method,
        reference: dto.reference,
        note: dto.note,
        receiptUrl: dto.receiptUrl,
        status: 'pending_confirmation',
        recordedById: user.id,
      },
    });
    const admins = await this.prisma.user.findMany({
      where: { roles: { has: 'admin' } },
      select: { id: true },
    });
    await Promise.all(
      admins.map((admin) =>
        notifyFinance(this.notifications, {
          userId: admin.id,
          titleEn: `${venue.nameEn} submitted ${formatMoney(dto.amount, currency)}`,
          titleAr: `${venue.nameAr} بعتت ${formatMoney(dto.amount, currency, 'ar')}`,
          bodyEn: 'Waiting for confirmation. No ledger change yet.',
          bodyAr: 'في انتظار التأكيد. مفيش تغيير في الحساب لسه.',
          payload: { venueId: dto.venueId, settlementId: settlement.id },
        }).catch(() => undefined),
      ),
    );
    return settlement;
  }

  async cancelRemittance(user: AuthenticatedUser, id: string) {
    const settlement = await this.prisma.venueSettlement.findUnique({ where: { id } });
    if (!settlement) throw new NotFoundException('Remittance not found');
    await assertVenueAccess(this.prisma, user, settlement.venueId, { write: true });
    if (settlement.status !== 'pending_confirmation') {
      throw new BadRequestException('Only pending remittances can be cancelled');
    }
    if (settlement.recordedById !== user.id && !user.roles.includes('owner')) {
      throw new BadRequestException('You can only cancel your own remittance');
    }
    return this.prisma.venueSettlement.update({
      where: { id },
      data: { status: 'rejected', rejectionReason: 'cancelled_by_owner' },
    });
  }

  async getMatchenaAccount(user: AuthenticatedUser, venueId: string) {
    const venue = await assertVenueAccess(this.prisma, user, venueId, { write: false });
    const currency = venue.currency;
    const [balance, commission, pending, settlements, entries] = await Promise.all([
      this.ledger.getBalance(venueId, currency),
      this.commission.resolveSource(venueId),
      this.prisma.venueSettlement.count({
        where: { venueId, status: 'pending_confirmation' },
      }),
      this.prisma.venueSettlement.findMany({
        where: { venueId },
        orderBy: { createdAt: 'desc' },
        take: 5,
      }),
      this.ledger.listEntries(venueId, { limit: 20 }),
    ]);
    const balanceExplanation =
      balance > 0 ? 'MATCHENA_OWES_YOU' : balance < 0 ? 'YOU_OWE_MATCHENA' : 'SETTLED';
    return {
      venueId,
      currency,
      balance,
      commissionBps: commission.bps,
      commissionSource: commission.source,
      paymentMode: venue.paymentMode,
      pendingRemittances: pending,
      lastSettlements: settlements,
      entries: entries.items,
      nextCursor: entries.nextCursor,
      balanceExplanation,
    };
  }

  /**
   * A customer's phone number is a `customers.view` matter: a staff account without it
   * still sees the booking (name, time, money) but never the number.
   */
  private async canSeePhones(user: AuthenticatedUser): Promise<boolean> {
    if (!user.roles.includes('staff') || user.roles.includes('admin') || user.roles.includes('owner')) return true;
    return scopeCan(await loadStaffScope(this.prisma, user.id), 'customers.view');
  }

  private withoutPhone<T extends { customer: { phone?: string | null } }>(dto: T): T {
    return { ...dto, customer: { ...dto.customer, phone: undefined } };
  }

  async toOwnerBookingDto(booking: Booking, user: AuthenticatedUser) {
    const loaded = await this.prisma.booking.findUniqueOrThrow({
      where: { id: booking.id },
      include: {
        venue:{select:{gamingReceiptsEnabled:true}},usageSession:{select:GAMING_BOOKING_MONEY_SELECT},
        court: { include: { sport: { select: { activityKind: true } } } },
        user: { select: { id: true, name: true, phone: true } },
        payments: {
          where: { status: { in: COUNTED_PAYMENT_STATUSES } },
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            amount: true,
            method: true,
            createdAt: true,
            recordedByUserId: true,
            reversesPaymentId: true,
            shiftId: true,
            note: true,
          },
        },
      },
    });
    const dto = this.mapLoaded(loaded);
    const reversed = new Set(loaded.payments.map((p) => p.reversesPaymentId).filter((x): x is string => !!x));
    const recorders = [...new Set(loaded.payments.map((p) => p.recordedByUserId).filter((x): x is string => !!x))];
    const names = new Map(
      (
        await this.prisma.user.findMany({ where: { id: { in: recorders } }, select: { id: true, name: true } })
      ).map((u) => [u.id, u.name]),
    );
    const canAll = await this.canManageEveryonesCash(user);
    const manual = loaded.source === 'manual';
    const withPayments = {
      ...dto,
      gamingOrderId:loaded.usageSession?.orderId??null,isLocked:!!loaded.usageSession||dto.isLocked,canEdit:!loaded.usageSession&&dto.canEdit,
      payments: [...loaded.payments,...gamingBookingPayments(loaded.usageSession)].map((p) => ({
        id: p.id,
        kind: p.amount < 0 ? ('refund' as const) : ('payment' as const),
        amount: p.amount,
        method: p.method,
        at: p.createdAt.toISOString(),
        byUserId: p.recordedByUserId,
        byName: p.recordedByUserId ? (names.get(p.recordedByUserId) ?? null) : null,
        note: p.note,
        reversesPaymentId: p.reversesPaymentId,
        reversed: reversed.has(p.id),
        canVoid:
          !loaded.usageSession && manual &&
          p.amount > 0 &&
          !reversed.has(p.id) &&
          (canAll || (p.recordedByUserId === user.id && p.shiftId == null)),
      })),
    };
    return (await this.canSeePhones(user)) ? withPayments : this.withoutPhone(withPayments);
  }

  private mapLoaded(b: {
    id: string;
    code: string;
    venueId: string;
    courtId: string;
    slotStart: Date;
    slotEnd: Date;
    status: Booking['status'];
    source: Booking['source'];
    sourceKey: string | null;
    sourceLabel: string | null;
    guestName: string | null;
    guestPhone: string | null;
    userId: string;
    user?: { id: string; name: string; phone: string | null } | null;
    court?: { name: string; sport?: { activityKind: string | null } | null } | null;
    totalAmount: number;
    baseAmount: number;
    feeAmount: number;
    discountAmount: number;
    ownerFundedDiscount: number;
    commissionBps: number | null;
    commissionAmount: number | null;
    ownerNetAmount: number | null;
    paymentStatus: Booking['paymentStatus'];
    paymentMethod: Booking['paymentMethod'];
    notes: string | null;
    checkedInAt: Date | null;
    currency: string;
    bundleId?: string | null;
    payments?: { amount: number }[];
    venue?:{gamingReceiptsEnabled:boolean};
    usageSession?: Parameters<typeof gamingBookingPayments>[0];
  }) {
    const durationMinutes = Math.round((b.slotEnd.getTime() - b.slotStart.getTime()) / 60_000);
    const { received: paidAmount, refunded } = netOf([...(b.payments ?? []),...gamingBookingPayments(b.usageSession)]);
    const statement = buildBookingStatement(b, paidAmount, refunded);
    const isLocked = b.source === 'platform';
    const tooOld = Date.now() - b.slotStart.getTime() > NINETY_DAYS_MS;
    const display = sourceDisplay(b.source, b.sourceKey, b.sourceLabel);
    const needsAttention =
      isLocked &&
      b.status === 'confirmed' &&
      !b.checkedInAt &&
      b.slotEnd <= new Date() &&
      b.slotEnd >= new Date(Date.now() - 24 * 3_600_000);
    return {
      id: b.id,
      code: b.code,
      venueId: b.venueId,
      courtId: b.courtId,
      courtName: b.court?.name,
      unitKind: b.court?.sport?.activityKind ?? null,
      startsAt: b.slotStart.toISOString(),
      endsAt: b.slotEnd.toISOString(),
      durationMinutes,
      status: b.status,
      source: b.source,
      sourceKey: b.sourceKey,
      sourceLabel: display.label,
      customer: {
        name: b.source === 'manual' ? b.guestName : b.user?.name,
        phoneMasked: b.source === 'platform' ? maskPlayerPhone(b.user?.phone) : null,
        phone: b.source === 'manual' ? b.guestPhone : undefined,
        userId: b.source === 'platform' ? b.userId : undefined,
      },
      money: {
        total: b.totalAmount,
        base: b.baseAmount,
        commissionAmount: isLocked ? b.commissionAmount : undefined,
        ownerNet: isLocked ? b.ownerNetAmount : undefined,
        paidAmount,
        outstanding: statement.outstanding,
        refunded,
        // Owner-funded discount, shown as its own line so base − discount − commission = net adds up.
        ownerFundedDiscount: statement.ownerDiscount,
        statement,
        currency: b.currency,
      },
      paymentStatus: b.paymentStatus,
      paymentMethod: b.paymentMethod,
      notes: b.notes,
      checkedInAt: b.checkedInAt?.toISOString() ?? null,
      bundleId: b.bundleId ?? null,
      receiptsEnabled:b.venue?.gamingReceiptsEnabled??false,
      gamingOrderId:b.usageSession?.orderId??null,
      isLocked:isLocked||!!b.usageSession,
      canEdit: !b.usageSession && !isLocked && !tooOld && b.status !== 'cancelled',
      needsAttention,
    };
  }

  /** Why a slot cannot be taken, or null when it is free. */
  async slotConflict(
    db: Prisma.TransactionClient | PrismaService,
    courtId: string,
    venueId: string,
    slotStart: Date,
    slotEnd: Date,
    excludeId?: string,
  ): Promise<'SLOT_ALREADY_HELD' | 'SLOT_BLOCKED' | null> {
    const overlap = await db.booking.findFirst({
      where: {
        courtId,
        status: { in: ['held', 'confirmed'] },
        slotStart: { lt: slotEnd },
        slotEnd: { gt: slotStart },
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      select: { id: true },
    });
    if (overlap) return 'SLOT_ALREADY_HELD';
    const shared = await db.resourceOccupancy.findFirst({where:{OR:[{resourceId:courtId},{resource:{gamingRoom:{bookableCourtId:courtId,occupancy:'exclusive'}}}],startsAt:{lt:slotEnd},AND:[{OR:[{endsAt:null},{endsAt:{gt:slotStart}}]}],...(excludeId?{NOT:{bookingId:excludeId}}:{})}});
    if(shared) return shared.blockId ? 'SLOT_BLOCKED' : 'SLOT_ALREADY_HELD';
    const blocked = await db.calendarBlock.findFirst({
      where: {
        venueId,
        OR: [{ courtId }, { courtId: null }],
        startsAt: { lt: slotEnd },
        endsAt: { gt: slotStart },
      },
      select: { id: true },
    });
    return blocked ? 'SLOT_BLOCKED' : null;
  }

  private async assertSlotFree(
    tx: Prisma.TransactionClient,
    courtId: string,
    venueId: string,
    slotStart: Date,
    slotEnd: Date,
    excludeId?: string,
  ) {
    const conflict = await this.slotConflict(tx, courtId, venueId, slotStart, slotEnd, excludeId);
    if (conflict === 'SLOT_ALREADY_HELD') {
      throw new ConflictException({ code: 'SLOT_ALREADY_HELD', message: 'Slot already held' });
    }
    if (conflict === 'SLOT_BLOCKED') {
      throw new ConflictException({ code: 'SLOT_BLOCKED', message: 'Slot is blocked' });
    }
  }

  private async touchCustomSource(
    tx: Prisma.TransactionClient,
    venueId: string,
    label: string,
  ) {
    const normalized = normalizeSourceLabel(label);
    await tx.venueBookingSource.upsert({
      where: { venueId_normalized: { venueId, normalized } },
      create: { venueId, label, normalized, useCount: 1, lastUsedAt: new Date() },
      update: { useCount: { increment: 1 }, lastUsedAt: new Date() },
    });
  }

  private async venueTz(venueId: string): Promise<string> {
    const venue = await this.prisma.venue.findUnique({
      where: { id: venueId },
      select: { country: { select: { timezone: true } } },
    });
    return venue?.country?.timezone ?? 'Africa/Cairo';
  }
}
