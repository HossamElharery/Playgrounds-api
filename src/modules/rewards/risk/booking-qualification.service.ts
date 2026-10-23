import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CHECKIN_EARLY_MS,
  CHECKIN_LATE_MS,
  TRUST_MIN_BOOKING_TOTAL,
  TRUST_MIN_LEAD_MS,
  VENUE_MIN_AGE_MS,
  requireVerifiedMoney,
} from '../coins-policy';
import { DeviceLinksService } from './device-links.service';

export type DisqualifyReason =
  | 'not_found'
  | 'not_completed_platform_booking'
  | 'too_small'
  | 'not_a_player'
  | 'rewards_blocked'
  | 'venue_insider'
  | 'venue_not_eligible'
  | 'last_minute'
  | 'outside_slot_window';

export type Qualification =
  | { ok: true; moneyVerified: boolean; venueId: string; userId: string }
  | { ok: false; reason: DisqualifyReason };

/**
 * One answer to "does this booking prove a real player played?". A venue's
 * check-in alone is a claim, so a booking only counts when nothing about it
 * points to the venue and the player being the same side:
 *  - a platform booking checked in during its slot, made before it started;
 *  - the player is a plain player account (not owner/staff/admin);
 *  - the player is not the venue's owner or staff, does not share the owner's
 *    or the checker's phone or device;
 *  - the venue is active, not frozen and has been live for two weeks
 *    (unless the money really went through the payment gateway).
 */
@Injectable()
export class BookingQualificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly links: DeviceLinksService,
  ) {}

  async assess(bookingId: string): Promise<Qualification> {
    const b = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: {
        id: true,
        userId: true,
        venueId: true,
        source: true,
        status: true,
        totalAmount: true,
        createdAt: true,
        slotStart: true,
        slotEnd: true,
        checkedInAt: true,
        checkedInByUserId: true,
        user: { select: { roles: true, status: true, phone: true, email: true, rewardsBlockedAt: true } },
        venue: {
          select: {
            ownerId: true,
            status: true,
            approvedAt: true,
            rewardsFrozenAt: true,
            contactPhone: true,
            owner: { select: { phone: true, email: true } },
          },
        },
      },
    });
    if (!b) return { ok: false, reason: 'not_found' };
    if (b.source !== 'platform' || b.status !== 'completed' || !b.checkedInAt)
      return { ok: false, reason: 'not_completed_platform_booking' };
    if (b.totalAmount < TRUST_MIN_BOOKING_TOTAL) return { ok: false, reason: 'too_small' };
    if (b.user.status !== 'active' || b.user.roles.some((r) => r !== 'player'))
      return { ok: false, reason: 'not_a_player' };
    if (b.user.rewardsBlockedAt) return { ok: false, reason: 'rewards_blocked' };

    // The venue's side: owner, anyone who works there, shared contact details or devices.
    const staff = await this.prisma.staffMember.findFirst({
      where: { userId: b.userId, ownerId: b.venue.ownerId },
      select: { id: true },
    });
    const samePhone =
      !!b.user.phone &&
      [b.venue.contactPhone, b.venue.owner.phone].some((p) => !!p && p === b.user.phone);
    const sameEmail =
      !!b.user.email && !!b.venue.owner.email && b.user.email.toLowerCase() === b.venue.owner.email.toLowerCase();
    if (b.userId === b.venue.ownerId || staff || samePhone || sameEmail || b.checkedInByUserId === b.userId)
      return { ok: false, reason: 'venue_insider' };
    const insiderIds = [b.venue.ownerId, b.checkedInByUserId].filter((x): x is string => !!x);
    const mine = await this.links.linkedIds(b.userId);
    if (insiderIds.some((id) => mine.has(id))) return { ok: false, reason: 'venue_insider' };

    const moneyVerified = !!(await this.prisma.paymentIntent.findFirst({
      where: { bookingId: b.id, status: 'paid', refundedAmount: 0 },
      select: { id: true },
    }));

    if (requireVerifiedMoney() && !moneyVerified)
      return { ok: false, reason: 'venue_not_eligible' };

    const slotStart = b.slotStart.getTime();
    const at = b.checkedInAt.getTime();
    if (at < slotStart - CHECKIN_EARLY_MS || at > b.slotEnd.getTime() + CHECKIN_LATE_MS)
      return { ok: false, reason: 'outside_slot_window' };
    if (b.createdAt.getTime() > slotStart - TRUST_MIN_LEAD_MS) return { ok: false, reason: 'last_minute' };

    const venueOld = !!b.venue.approvedAt && Date.now() - b.venue.approvedAt.getTime() >= VENUE_MIN_AGE_MS;
    if (b.venue.status !== 'active' || b.venue.rewardsFrozenAt || (!venueOld && !moneyVerified))
      return { ok: false, reason: 'venue_not_eligible' };

    return { ok: true, moneyVerified, venueId: b.venueId, userId: b.userId };
  }
}
