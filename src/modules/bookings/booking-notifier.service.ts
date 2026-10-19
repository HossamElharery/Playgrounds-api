import { Injectable, Logger, Optional } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RealtimeGatewayEmitter } from '../realtime/realtime-emitter.interface';
import { moneyText } from '../../common/money/money-text';
import { zonedHhmm, zonedYmd } from '../../common/utils/timezone.util';

/** Staff who may see a venue's bookings; money is shown only to those who may see money. */
const BOOKING_VIEW = 'bookings.view';
const MONEY_PERMISSIONS = ['account.view', 'reports.view'];

export type BookingNoticeKind = 'booking_confirmed' | 'booking_cancelled';

export interface BookingNoticeRecipient {
  userId: string;
  /** Owner of the venue, or staff allowed to see the money columns. */
  seesMoney: boolean;
  isOwner: boolean;
}

/** Pure: who is told about a booking at a venue, and how much they may see. */
export function selectBookingRecipients(
  venue: { ownerId: string },
  staff: Array<{ userId: string; permissions: string[]; venueIds: string[]; ownerId: string }>,
  venueId: string,
): BookingNoticeRecipient[] {
  const out = new Map<string, BookingNoticeRecipient>();
  out.set(venue.ownerId, { userId: venue.ownerId, seesMoney: true, isOwner: true });
  for (const member of staff) {
    if (member.ownerId !== venue.ownerId) continue; // another organisation's staff
    if (!member.venueIds.includes(venueId)) continue; // outside the venue scope
    if (!member.permissions.includes(BOOKING_VIEW)) continue;
    if (out.has(member.userId)) continue;
    out.set(member.userId, {
      userId: member.userId,
      seesMoney: MONEY_PERMISSIONS.some((p) => member.permissions.includes(p)),
      isOwner: false,
    });
  }
  return [...out.values()];
}

export function bookingNoticeDedupKey(
  kind: BookingNoticeKind,
  bookingId: string,
  userId: string,
): string {
  return kind === 'booking_confirmed'
    ? `booking-confirmed-owner:${bookingId}:${userId}`
    : `booking-cancelled-owner:${bookingId}:${userId}`;
}

const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [250, 1_000, 3_000];
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Tells the venue side about a booking: the owner, plus staff who can see this
 * venue's bookings. The in-app row is the durable record (unique dedupKey, so a
 * retry, a duplicate confirm or a second backend instance can never produce a
 * second notification); push and realtime are best-effort on top of it.
 */
@Injectable()
export class BookingNotifier {
  private readonly logger = new Logger(BookingNotifier.name);
  /** Back-off between attempts; tests shorten it. */
  retryDelaysMs: readonly number[] = DEFAULT_RETRY_DELAYS_MS;

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    @Optional() private readonly realtime?: RealtimeGatewayEmitter,
  ) {}

  /**
   * Never throws: a notification problem must not undo a paid booking. Failures
   * are retried, then logged at error level and sent to Sentry; the periodic
   * reconciliation in JobsService picks up anything still missing.
   */
  async notifyVenueSide(bookingId: string, kind: BookingNoticeKind): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.dispatch(bookingId, kind);
        return;
      } catch (error) {
        if (attempt >= this.retryDelaysMs.length) {
          this.logger.error(
            `Venue notice ${kind} for booking ${bookingId} failed after ${attempt + 1} attempts: ${String(error)}`,
          );
          Sentry.captureException(error, { tags: { area: 'booking-notice', kind }, extra: { bookingId } });
          return;
        }
        await sleep(this.retryDelaysMs[attempt]);
      }
    }
  }

  private async dispatch(bookingId: string, kind: BookingNoticeKind): Promise<void> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: {
        user: { select: { name: true } },
        court: { select: { name: true } },
        venue: {
          select: {
            id: true,
            ownerId: true,
            nameAr: true,
            nameEn: true,
            country: { select: { timezone: true } },
          },
        },
      },
    });
    if (!booking || booking.source !== 'platform') return; // manual bookings are the owner's own action
    if (kind === 'booking_confirmed' && booking.status === 'cancelled') return;

    const staff = await this.prisma.staffMember.findMany({
      where: {
        ownerId: booking.venue.ownerId,
        venueIds: { has: booking.venueId },
        permissions: { has: BOOKING_VIEW },
        user: { status: 'active', roles: { has: 'staff' } },
      },
      select: { userId: true, ownerId: true, permissions: true, venueIds: true },
    });
    const recipients = selectBookingRecipients(booking.venue, staff, booking.venueId);

    const tz = booking.venue.country.timezone;
    const day = zonedYmd(booking.slotStart, tz);
    const time = zonedHhmm(booking.slotStart, tz);
    const minutes = Math.round((booking.slotEnd.getTime() - booking.slotStart.getTime()) / 60_000);
    const customer = booking.user.name?.trim() || booking.guestName?.trim() || '—';
    const confirmed = kind === 'booking_confirmed';
    const paid = booking.paymentStatus === 'paid';
    const payAr = paid ? 'مدفوع' : booking.paymentStatus === 'partial' ? 'مدفوع جزئيًا' : 'الدفع في الملعب';
    const payEn = paid ? 'Paid' : booking.paymentStatus === 'partial' ? 'Partly paid' : 'Pay at venue';

    let firstError: unknown;
    for (const recipient of recipients) {
      try {
        const amountAr = recipient.seesMoney ? ` · ${moneyText(booking.totalAmount, booking.currency, 'ar')}` : '';
        const amountEn = recipient.seesMoney ? ` · ${moneyText(booking.totalAmount, booking.currency, 'en')}` : '';
        const where = `${booking.venue.nameEn} — ${booking.court.name}`;
        const whereAr = `${booking.venue.nameAr} — ${booking.court.name}`;
        await this.notifications.create({
          dedupKey: bookingNoticeDedupKey(kind, booking.id, recipient.userId),
          userId: recipient.userId,
          category: 'bookings',
          titleEn: confirmed ? `New booking · ${where}` : `Booking cancelled · ${where}`,
          titleAr: confirmed ? `حجز جديد · ${whereAr}` : `إلغاء حجز · ${whereAr}`,
          bodyEn: `${booking.code} · ${customer} · ${day} ${time} (${minutes} min) · ${payEn}${amountEn}`,
          bodyAr: `${booking.code} · ${customer} · ${day} ${time} (${minutes} دقيقة) · ${payAr}${amountAr}`,
          // Opens this booking in the owner app (web, Android and iOS): the owner layout reads
          // the venue / booking query parameters and opens the booking sheet.
          deepLink: `/owner/bookings?venue=${booking.venueId}&booking=${booking.id}`,
          payload: {
            kind,
            bookingId: booking.id,
            venueId: booking.venueId,
            courtId: booking.courtId,
            code: booking.code,
            slotStart: booking.slotStart.toISOString(),
            slotEnd: booking.slotEnd.toISOString(),
            paymentStatus: booking.paymentStatus,
            ...(recipient.seesMoney
              ? { totalAmount: booking.totalAmount, currency: booking.currency }
              : {}),
          },
        });
        this.realtime?.emitToUser(recipient.userId, {
          type: confirmed ? 'booking.confirmed' : 'booking.cancelled',
          bookingId: booking.id,
          venueId: booking.venueId,
        });
      } catch (error) {
        firstError ??= error;
      }
    }
    // One recipient failing must not stop the others; it still triggers a retry,
    // which is safe because the dedupKey makes a repeat a no-op for the rest.
    if (firstError) throw firstError;
  }
}
