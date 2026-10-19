import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RealtimeGatewayEmitter } from '../realtime/realtime-emitter.interface';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.interface';
import { assertVenueAccess } from '../../common/access/owner-access';
import { ApiException } from '../../common/errors/api-exception';
import { loadBookingBlockers } from '../../common/utils/venue-readiness.util';
import {
  computeVenueState,
  type VenueEffectiveState,
} from '../../common/utils/venue-visibility.util';

const VENUE_STATE_SELECT = {
  id: true,
  ownerId: true,
  slug: true,
  nameAr: true,
  nameEn: true,
  status: true,
  ownerListingEnabled: true,
  adminHidden: true,
  instantBook: true,
  operationsEnabled: true,
  paymentMode: true,
  moderationReason: true,
  moderatedById: true,
  moderatedAt: true,
  listingChangedById: true,
  listingChangedAt: true,
  updatedAt: true,
} as const;

type VenueStateRow = Prisma.VenueGetPayload<{ select: typeof VENUE_STATE_SELECT }>;

export interface VenueStateView {
  venueId: string;
  slug: string;
  status: VenueStateRow['status'];
  ownerListingEnabled: boolean;
  adminHidden: boolean;
  /** `instantBook` in the database: the venue accepts new Matchena bookings. */
  bookingEnabled: boolean;
  operationsEnabled: boolean;
  paymentMode: VenueStateRow['paymentMode'];
  moderation: { reason: string | null; byId: string | null; at: string | null } | null;
  listingChangedAt: string | null;
  effective: VenueEffectiveState;
  futureBookings: number;
  updatedAt: string;
}

export type OwnerSwitch = 'listing' | 'booking' | 'operations';

const SWITCH_COLUMN = {
  listing: 'ownerListingEnabled',
  booking: 'instantBook',
  operations: 'operationsEnabled',
} as const;

const SWITCH_ACTION = {
  listing: 'owner.venue.listing',
  booking: 'owner.venue.booking_availability',
  operations: 'owner.venue.operations',
} as const;

/**
 * Owner and admin controls over a venue's visibility on Matchena.
 *
 * Each concept is its own column and its own endpoint, so a PATCH can never
 * flip a field it was not meant to:
 *   listing     ownerListingEnabled   owner's wish to be listed
 *   booking     instantBook           accepting new Matchena bookings
 *   operations  operationsEnabled     owner management system on/off
 *   admin hide  adminHidden           platform unlisting the owner cannot lift
 *   status      Venue.status          approval / suspension (ManagementService)
 */
@Injectable()
export class VenueListingService {
  private readonly logger = new Logger(VenueListingService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly notifications?: NotificationsService,
    @Optional() private readonly realtime?: RealtimeGatewayEmitter,
  ) {}

  async stateOf(venueId: string): Promise<VenueStateView> {
    const venue = await this.prisma.venue.findUnique({
      where: { id: venueId },
      select: VENUE_STATE_SELECT,
    });
    if (!venue) throw new NotFoundException('Venue not found');
    return this.view(venue);
  }

  async ownerState(user: AuthenticatedUser, venueId: string): Promise<VenueStateView> {
    await assertVenueAccess(this.prisma, user, venueId, { write: false });
    return this.stateOf(venueId);
  }

  async ownerSet(
    user: AuthenticatedUser,
    venueId: string,
    which: OwnerSwitch,
    enabled: boolean,
    opts: { acknowledgeFutureBookings?: boolean } = {},
  ): Promise<VenueStateView> {
    const venue = await assertVenueAccess(this.prisma, user, venueId, { write: true });
    // Staff never reach this: the routes are owner/admin only. An admin acting here
    // is the owner's proxy (edit mode), never an override of moderation.
    if (user.roles.includes('staff') && !user.roles.includes('owner') && !user.roles.includes('admin')) {
      throw new ForbiddenException('Only the venue owner can change this');
    }
    const column = SWITCH_COLUMN[which];
    const current = venue[column] as boolean;

    if (current === enabled) return this.stateOf(venueId); // idempotent: no write, no audit

    if (enabled && (which === 'listing' || which === 'booking')) {
      // The platform's decision beats the owner's preference.
      if (venue.status === 'suspended' || venue.adminHidden) {
        throw new ApiException(
          403,
          'VENUE_LOCKED_BY_ADMIN',
          'Matchena has restricted this venue. Contact support to have it restored.',
        );
      }
      if (venue.status === 'active') await this.assertReady(venueId);
    }

    if (!enabled && which !== 'operations') {
      const future = await this.futureBookings(venueId);
      if (future > 0 && !opts.acknowledgeFutureBookings) {
        throw new ConflictException({
          code: 'FUTURE_BOOKINGS_EXIST',
          message:
            'This venue has upcoming bookings. They stay valid; only new bookings stop.',
          futureBookings: future,
        });
      }
    }

    const before = this.snapshot(venue);
    const changed = await this.prisma.$transaction(async (tx) => {
      // Single-column conditional write: a concurrent change to any other field
      // is never overwritten, and a concurrent identical request is a no-op.
      const res = await tx.venue.updateMany({
        where: { id: venueId, [column]: current },
        data: {
          [column]: enabled,
          listingChangedById: user.id,
          listingChangedAt: new Date(),
        },
      });
      if (res.count !== 1) return false;
      await tx.auditLogEntry.create({
        data: {
          actorUserId: user.id,
          action: SWITCH_ACTION[which],
          targetType: 'venue',
          targetId: venueId,
          metadata: {
            venueId,
            before,
            after: { ...before, [column]: enabled },
            onBehalfOfAdmin: user.roles.includes('admin'),
          } as unknown as Prisma.InputJsonValue,
        },
      });
      return true;
    });

    const state = await this.stateOf(venueId);
    if (changed) this.announce(venue.ownerId, state);
    return state;
  }

  /** Admin: hide (or show again) a venue without touching the owner's preference. */
  async adminSetListing(
    adminId: string,
    venueId: string,
    hidden: boolean,
    reason: string,
  ): Promise<VenueStateView> {
    const venue = await this.prisma.venue.findUnique({
      where: { id: venueId },
      select: VENUE_STATE_SELECT,
    });
    if (!venue) throw new NotFoundException('Venue not found');
    if (venue.adminHidden === hidden) return this.view(venue);
    if (!hidden) {
      // Lifting a hide must not publish something that is not publishable.
      if (venue.status === 'active' && venue.ownerListingEnabled) await this.assertReady(venueId);
    }
    const before = this.snapshot(venue);
    const stamp = new Date();
    const changed = await this.prisma.$transaction(async (tx) => {
      const res = await tx.venue.updateMany({
        where: { id: venueId, adminHidden: venue.adminHidden },
        data: {
          adminHidden: hidden,
          moderationReason: hidden ? reason.slice(0, 500) : null,
          moderatedById: adminId,
          moderatedAt: stamp,
        },
      });
      if (res.count !== 1) return false;
      await tx.auditLogEntry.create({
        data: {
          actorUserId: adminId,
          action: hidden ? 'admin.venue.hide' : 'admin.venue.show',
          targetType: 'venue',
          targetId: venueId,
          metadata: {
            venueId,
            reason,
            before,
            after: { ...before, adminHidden: hidden },
          } as unknown as Prisma.InputJsonValue,
        },
      });
      return true;
    });
    const state = await this.stateOf(venueId);
    if (changed) {
      this.announce(venue.ownerId, state);
      await this.notifyOwner(venue, hidden ? 'hidden' : 'shown', reason, stamp);
    }
    return state;
  }

  private async assertReady(venueId: string): Promise<void> {
    const missing = await loadBookingBlockers(this.prisma as never, venueId);
    if (missing.length) {
      throw new ConflictException({
        code: 'VENUE_NOT_READY',
        message: `Venue cannot be shown yet: missing ${missing.join(', ')}`,
        missing,
      });
    }
  }

  private futureBookings(venueId: string): Promise<number> {
    return this.prisma.booking.count({
      where: {
        venueId,
        status: { in: ['held', 'confirmed'] },
        slotStart: { gte: new Date() },
      },
    });
  }

  private snapshot(v: VenueStateRow) {
    return {
      status: v.status,
      ownerListingEnabled: v.ownerListingEnabled,
      adminHidden: v.adminHidden,
      instantBook: v.instantBook,
      operationsEnabled: v.operationsEnabled,
    };
  }

  private async view(venue: VenueStateRow): Promise<VenueStateView> {
    const [missing, futureBookings] = await Promise.all([
      loadBookingBlockers(this.prisma as never, venue.id),
      this.futureBookings(venue.id),
    ]);
    // Readiness only matters while the venue is otherwise ready to be shown.
    const effective = computeVenueState(venue, missing);
    const locked = effective.lockedByAdmin;
    return {
      venueId: venue.id,
      slug: venue.slug,
      status: venue.status,
      ownerListingEnabled: venue.ownerListingEnabled,
      adminHidden: venue.adminHidden,
      bookingEnabled: venue.instantBook,
      operationsEnabled: venue.operationsEnabled,
      paymentMode: venue.paymentMode,
      moderation:
        locked || venue.moderationReason
          ? {
              reason: venue.moderationReason,
              byId: venue.moderatedById,
              at: venue.moderatedAt?.toISOString() ?? null,
            }
          : null,
      listingChangedAt: venue.listingChangedAt?.toISOString() ?? null,
      effective,
      futureBookings,
      updatedAt: venue.updatedAt.toISOString(),
    };
  }

  private announce(ownerId: string, state: VenueStateView) {
    this.realtime?.emitToUser(ownerId, {
      type: 'venue.visibility.changed',
      venueId: state.venueId,
      listing: state.effective.listing,
      bookable: state.effective.bookable,
    });
  }

  private async notifyOwner(
    venue: VenueStateRow,
    change: 'hidden' | 'shown',
    reason: string,
    stamp: Date,
  ) {
    if (!this.notifications) return;
    const hidden = change === 'hidden';
    await this.notifications
      .create({
        dedupKey: `venue-listing:${venue.id}:${change}:${stamp.getTime()}`,
        userId: venue.ownerId,
        category: 'system',
        titleEn: hidden
          ? `${venue.nameEn} was hidden by Matchena`
          : `${venue.nameEn} is visible again`,
        titleAr: hidden
          ? `قامت ماتشنا بإخفاء ${venue.nameAr}`
          : `${venue.nameAr} ظاهر من جديد`,
        bodyEn: hidden ? reason : 'Matchena lifted the restriction on your venue.',
        bodyAr: hidden ? reason : 'رفعت ماتشنا القيد عن ملعبك.',
        deepLink: '/owner/venues',
        payload: { kind: 'venue_listing', venueId: venue.id, hidden },
      })
      .catch((error: unknown) =>
        this.logger.warn(`Venue listing notice failed for ${venue.id}: ${String(error)}`),
      );
  }
}
