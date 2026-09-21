import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PartnerApplicationStatus, Prisma, VenueStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from '../auth/auth.service';
import { NotificationsService } from '../notifications/notifications.service';
import { VenuesService } from '../venues/venues.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { ApiException } from '../../common/errors/api-exception';
import { encodeGeohash } from '../../common/utils/geo.util';
import { normalizeCountryCode } from '../../common/geo/country.util';
import {
  isValidUsername,
  normalizeUsername,
} from '../../common/utils/username.util';
import { paginateByCursor } from '../../common/pagination/cursor-pagination.dto';
import { buildActivityFields } from '../../common/utils/activity-fields.util';
import { PartnerRegisterDto, PartnerLoginDto } from './dto/partner-auth.dto';
import {
  AdminAmendPartnerApplicationDto,
  CreatePartnerApplicationDto,
  PartnerDecisionDto,
  PatchPartnerApplicationDto,
} from './dto/partner-application.dto';
import {
  OWNER_EDITABLE_STATUSES,
  PartnerApplicationPayload,
} from './partner.types';
import {
  sanitizePayload,
  validatePartnerSubmission,
} from './partner-validation';

const CANCELLATION_PRESETS: Record<string, string> = {
  flexible_24h: 'Free cancel until 24 hours before kickoff',
  flexible_12h: 'Free cancel until 12 hours before kickoff',
  non_refundable: 'Non-refundable',
};

const OWNER_EDITABLE = new Set<string>(OWNER_EDITABLE_STATUSES);

@Injectable()
export class PartnersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly notifications: NotificationsService,
    private readonly venues: VenuesService,
    private readonly subscriptions: SubscriptionsService,
  ) {}

  usernameAvailability(raw: string) {
    const username = normalizeUsername(raw);
    if (!isValidUsername(raw)) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        'USERNAME_INVALID',
        'Username must start with a letter and be 4–30 letters, digits, dots or underscores',
      );
    }
    return this.prisma.user
      .findUnique({ where: { username }, select: { id: true } })
      .then((existing) => ({
        username,
        available: !existing,
      }));
  }

  register(dto: PartnerRegisterDto) {
    return this.auth.registerPartner(dto);
  }

  login(dto: PartnerLoginDto) {
    if (!dto.username && !dto.email) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        'IDENTIFIER_REQUIRED',
        'Username or email is required',
      );
    }
    return this.auth.loginPartner(dto);
  }

  async listMine(ownerId: string, cursor?: string, limit = 20) {
    const page = await paginateByCursor(
      (args) =>
        this.prisma.partnerApplication.findMany({
          where: { ownerId },
          orderBy: { id: 'desc' },
          include: { events: { orderBy: { createdAt: 'desc' }, take: 20 } },
          ...args,
        }),
      Math.min(limit, 50),
      cursor,
    );
    return {
      items: page.items.map((row) => this.toOwnerDto(row)),
      nextCursor: page.nextCursor,
    };
  }

  async createDraft(ownerId: string, dto: CreatePartnerApplicationDto) {
    const payload = sanitizePayload(dto.payload as PartnerApplicationPayload);
    const names = this.namesFrom(payload);
    const created = await this.prisma.partnerApplication.create({
      data: {
        ownerId,
        status: 'draft',
        payload: payload as Prisma.InputJsonValue,
        publicNameEn: names.publicNameEn,
        publicNameAr: names.publicNameAr,
        contactPhone: payload.contactPhone || '',
        countryCode: normalizeCountryCode(payload.countryCode) ?? 'EG',
        governorateId: payload.governorateId,
        districtId: payload.districtId,
        lat: payload.lat ?? undefined,
        lng: payload.lng ?? undefined,
        events: {
          create: {
            actorUserId: ownerId,
            fromStatus: 'draft',
            toStatus: 'draft',
            note: 'Draft created',
          },
        },
      },
      include: { events: { orderBy: { createdAt: 'desc' }, take: 20 } },
    });
    return this.toOwnerDto(created);
  }

  async patchOwned(
    ownerId: string,
    id: string,
    dto: PatchPartnerApplicationDto,
    ifMatch?: string,
  ) {
    const app = await this.loadOwned(id, ownerId);
    this.assertVersion(app.version, dto.version, ifMatch);
    if (!OWNER_EDITABLE.has(app.status)) {
      throw new ApiException(
        HttpStatus.CONFLICT,
        'APPLICATION_NOT_EDITABLE',
        'This application cannot be overwritten in its current state',
      );
    }

    const payload = sanitizePayload({
      ...(app.payload as PartnerApplicationPayload),
      ...(dto.payload as PartnerApplicationPayload),
    });
    const names = this.namesFrom(payload);
    const editingLive = app.status === 'approved';
    const nextStatus: PartnerApplicationStatus = editingLive
      ? 'draft'
      : app.status;

    const updated = await this.prisma.$transaction(async (tx) => {
      if (editingLive && app.venueId) {
        await tx.venue.update({
          where: { id: app.venueId },
          data: { status: 'pending' },
        });
      }
      const row = await tx.partnerApplication.update({
        where: { id },
        data: {
          payload: payload as Prisma.InputJsonValue,
          publicNameEn: names.publicNameEn,
          publicNameAr: names.publicNameAr,
          contactPhone: payload.contactPhone || app.contactPhone,
          countryCode:
            normalizeCountryCode(payload.countryCode) ?? app.countryCode,
          governorateId: payload.governorateId,
          districtId: payload.districtId,
          lat: payload.lat ?? undefined,
          lng: payload.lng ?? undefined,
          status: nextStatus,
          version: { increment: 1 },
          events: editingLive
            ? {
                create: {
                  actorUserId: ownerId,
                  fromStatus: app.status,
                  toStatus: 'draft',
                  note: 'Owner edited a live listing; removed from discovery pending resubmit',
                },
              }
            : undefined,
        },
        include: { events: { orderBy: { createdAt: 'desc' }, take: 20 } },
      });
      return row;
    });
    return this.toOwnerDto(updated);
  }

  async submit(ownerId: string, id: string, ifMatch?: string) {
    const app = await this.loadOwned(id, ownerId);
    this.assertVersion(app.version, undefined, ifMatch);
    if (!['draft', 'changes_requested'].includes(app.status)) {
      throw new ApiException(
        HttpStatus.CONFLICT,
        'APPLICATION_NOT_SUBMITTABLE',
        'Only drafts and change-requested applications can be submitted',
      );
    }

    const payload = sanitizePayload(app.payload as PartnerApplicationPayload);
    const errors = validatePartnerSubmission(payload);
    if (errors.length) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        'APPLICATION_INCOMPLETE',
        errors.join('; '),
      );
    }

    await this.assertGeoAndSports(payload);

    const updated = await this.prisma.partnerApplication.update({
      where: { id },
      data: {
        payload: payload as Prisma.InputJsonValue,
        publicNameEn: payload.publicNameEn!,
        publicNameAr: payload.publicNameAr!,
        contactPhone: payload.contactPhone!,
        countryCode:
          normalizeCountryCode(payload.countryCode) ?? app.countryCode,
        governorateId: payload.governorateId,
        districtId: payload.districtId,
        lat: payload.lat!,
        lng: payload.lng!,
        status: 'pending',
        submittedAt: new Date(),
        version: { increment: 1 },
        events: {
          create: {
            actorUserId: ownerId,
            fromStatus: app.status,
            toStatus: 'pending',
            note: 'Submitted for review',
          },
        },
      },
      include: { events: { orderBy: { createdAt: 'desc' }, take: 20 } },
    });
    return this.toOwnerDto(updated);
  }

  async adminList(
    status?: PartnerApplicationStatus,
    cursor?: string,
    limit = 50,
  ) {
    const page = await paginateByCursor(
      (args) =>
        this.prisma.partnerApplication.findMany({
          where: status ? { status } : { status: { not: 'draft' } },
          orderBy: { id: 'desc' },
          include: {
            owner: {
              select: {
                id: true,
                name: true,
                email: true,
                username: true,
                phone: true,
              },
            },
            venue: { select: { id: true, slug: true, status: true } },
            events: { orderBy: { createdAt: 'desc' }, take: 20 },
          },
          ...args,
        }),
      limit,
      cursor,
    );
    return {
      items: page.items.map((row) => this.toAdminDto(row)),
      nextCursor: page.nextCursor,
    };
  }

  async adminGet(id: string) {
    const app = await this.prisma.partnerApplication.findUnique({
      where: { id },
      include: {
        owner: {
          select: {
            id: true,
            name: true,
            email: true,
            username: true,
            phone: true,
          },
        },
        venue: { select: { id: true, slug: true, status: true } },
        events: { orderBy: { createdAt: 'desc' }, take: 40 },
      },
    });
    if (!app) throw new NotFoundException('Application not found');
    return this.toAdminDto(app);
  }

  async adminAmend(
    adminId: string,
    id: string,
    dto: AdminAmendPartnerApplicationDto,
    ifMatch?: string,
  ) {
    const app = await this.load(id);
    this.assertVersion(app.version, dto.version, ifMatch);
    // Admins may curate any application except a rejected one.
    if (app.status === 'rejected') {
      throw new ApiException(
        HttpStatus.CONFLICT,
        'APPLICATION_NOT_AMENDABLE',
        'This application cannot be amended in its current state',
      );
    }

    const base = app.payload as PartnerApplicationPayload;
    // A full `payload` gives the admin control over everything; otherwise fall
    // back to the legacy field-level overrides.
    const merged: PartnerApplicationPayload = dto.payload
      ? { ...base, ...(dto.payload as unknown as PartnerApplicationPayload) }
      : {
          ...base,
          publicNameEn: dto.publicNameEn ?? base.publicNameEn,
          publicNameAr: dto.publicNameAr ?? base.publicNameAr,
          descriptionEn: dto.descriptionEn ?? base.descriptionEn,
          descriptionAr: dto.descriptionAr ?? base.descriptionAr,
          address: dto.address ?? base.address,
        };
    const payload = sanitizePayload(merged);
    const reason = dto.reason?.trim();

    const updated = await this.prisma.$transaction(async (tx) => {
      // Keep a published venue in sync with content the admin curated. This
      // updates scalar fields, gallery, sports and amenities but deliberately
      // never rebuilds courts here (they may carry live bookings) — court
      // structure changes on live venues go through venue management.
      if (app.venueId) {
        await this.syncVenueContent(tx, app.venueId, payload);
      }
      return tx.partnerApplication.update({
        where: { id },
        data: {
          payload: payload as Prisma.InputJsonValue,
          publicNameEn: payload.publicNameEn || app.publicNameEn,
          publicNameAr: payload.publicNameAr || app.publicNameAr,
          contactPhone: payload.contactPhone || app.contactPhone,
          countryCode:
            normalizeCountryCode(payload.countryCode) ?? app.countryCode,
          governorateId: payload.governorateId ?? app.governorateId,
          districtId: payload.districtId ?? app.districtId,
          lat: payload.lat ?? undefined,
          lng: payload.lng ?? undefined,
          version: { increment: 1 },
          events: {
            create: {
              actorUserId: adminId,
              fromStatus: app.status,
              toStatus: app.status,
              note: reason || 'Admin edited the listing',
            },
          },
        },
        include: {
          owner: {
            select: {
              id: true,
              name: true,
              email: true,
              username: true,
              phone: true,
            },
          },
          venue: { select: { id: true, slug: true, status: true } },
          events: { orderBy: { createdAt: 'desc' }, take: 20 },
        },
      });
    });

    if (app.venueId) {
      await this.venues.refreshVenuePriceFrom(app.venueId);
    }
    // Only ping the partner when the admin actually left a message for them.
    if (reason) {
      await this.notifications.create({
        userId: app.ownerId,
        category: 'bookings',
        titleEn: 'Your listing was updated by Matchena',
        titleAr: 'تم تحديث إعلانك بواسطة ماتشنا',
        bodyEn: reason,
        bodyAr: reason,
        deepLink: `/partners/join?application=${id}`,
      });
    }
    return this.toAdminDto(updated);
  }

  /**
   * Propagates admin-curated content to a live venue without touching courts.
   * Safe to run repeatedly: scalars are overwritten, gallery/sports/amenities
   * are rebuilt from the payload.
   */
  private async syncVenueContent(
    tx: Prisma.TransactionClient,
    venueId: string,
    payload: PartnerApplicationPayload,
  ) {
    const cancellationPolicy =
      payload.cancellationPreset && payload.cancellationPreset !== 'custom'
        ? CANCELLATION_PRESETS[payload.cancellationPreset]
        : payload.cancellationPolicy;

    await tx.venue.update({
      where: { id: venueId },
      data: {
        ...(payload.publicNameEn ? { nameEn: payload.publicNameEn } : {}),
        ...(payload.publicNameAr ? { nameAr: payload.publicNameAr } : {}),
        descriptionEn: payload.descriptionEn,
        descriptionAr: payload.descriptionAr,
        address: payload.address,
        ...(payload.contactPhone ? { contactPhone: payload.contactPhone } : {}),
        ...(cancellationPolicy ? { cancellationPolicy } : {}),
        houseRules: payload.houseRules,
        ...(payload.weeklyHours
          ? {
              weeklyHours:
                payload.weeklyHours as unknown as Prisma.InputJsonValue,
            }
          : {}),
        ...(payload.lat != null && payload.lng != null
          ? {
              lat: payload.lat,
              lng: payload.lng,
              geohash: encodeGeohash(payload.lat, payload.lng),
            }
          : {}),
      },
    });

    const photos = payload.photos ?? [];
    await tx.venuePhoto.deleteMany({ where: { venueId } });
    if (photos.length) {
      await tx.venuePhoto.createMany({
        data: photos.map((photo, position) => ({
          venueId,
          url: photo.url!,
          position: photo.isCover ? 0 : position + 1,
        })),
      });
    }

    const sportIds = Array.from(
      new Set((payload.courts ?? []).map((c) => c.sportId).filter(Boolean)),
    ) as string[];
    if (sportIds.length) {
      const inUse = await tx.court.findMany({
        where: { venueId },
        select: { sportId: true },
      });
      const required = new Set([...sportIds, ...inUse.map((c) => c.sportId)]);
      await tx.venueSport.deleteMany({
        where: { venueId, sportId: { notIn: [...required] } },
      });
      await tx.venueSport.createMany({
        data: [...required].map((sportId) => ({ venueId, sportId })),
        skipDuplicates: true,
      });
    }

    const amenityKeys = Array.from(
      new Set((payload.courts ?? []).flatMap((c) => c.amenityKeys ?? [])),
    );
    await tx.venueAmenity.deleteMany({ where: { venueId } });
    if (amenityKeys.length) {
      const amenities = await tx.amenity.findMany({
        where: { key: { in: amenityKeys } },
      });
      if (amenities.length) {
        await tx.venueAmenity.createMany({
          data: amenities.map((a) => ({ venueId, amenityId: a.id })),
          skipDuplicates: true,
        });
      }
    }
  }

  async decide(
    adminId: string,
    id: string,
    dto: PartnerDecisionDto,
    ifMatch?: string,
  ) {
    const app = await this.load(id);
    this.assertVersion(app.version, dto.version, ifMatch);
    this.assertDecisionAllowed(app.status, dto.action);
    const needsPartnerNote =
      dto.action === 'reject' || dto.action === 'request_changes';
    if (needsPartnerNote && !(dto.note && dto.note.trim().length >= 10)) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        'DECISION_NOTE_REQUIRED',
        'A note of 10–1000 characters is required when rejecting or requesting changes',
      );
    }

    const nextStatus = this.statusForAction(dto.action);
    const payload = sanitizePayload(app.payload as PartnerApplicationPayload);
    if (dto.action === 'approve') {
      payload.courts = (payload.courts ?? []).map((court) => ({
        ...court,
        sportId: this.normalizeSportId(court.sportId),
      }));
      const errors = validatePartnerSubmission(payload);
      if (errors.length) {
        throw new ApiException(
          HttpStatus.BAD_REQUEST,
          'APPLICATION_INCOMPLETE',
          errors.join('; '),
        );
      }
      await this.assertGeoAndSports(payload);
      // A venue never goes live without saying how long its subscription runs.
      const hasSubscription = app.venueId
        ? !!(await this.prisma.venueSubscription.findUnique({ where: { venueId: app.venueId }, select: { id: true } }))
        : false;
      if (!hasSubscription && !dto.subscriptionDays) {
        throw new ApiException(
          HttpStatus.BAD_REQUEST,
          'SUBSCRIPTION_DAYS_REQUIRED',
          'Enter how many days this venue is covered for before approving',
        );
      }
    }

    let updated;
    try {
      updated = await this.prisma.$transaction(async (tx) => {
        let venueId = app.venueId;
        if (dto.action === 'approve') {
          venueId = await this.publishVenue(
            tx,
            adminId,
            app.ownerId,
            payload,
            venueId,
          );
          if (dto.subscriptionDays) {
            await this.subscriptions.startOrExtendOnApproval(
              tx,
              adminId,
              venueId,
              dto.subscriptionDays,
              dto.agreedPriceAmount,
            );
          } else {
            await this.subscriptions.ensure(venueId, undefined, tx);
          }
        } else if (dto.action === 'suspend' && venueId) {
          await tx.venue.update({
            where: { id: venueId },
            data: { status: 'suspended' },
          });
        } else if (dto.action === 'request_changes' && venueId) {
          await tx.venue.update({
            where: { id: venueId },
            data: { status: 'pending' },
          });
        }

        return tx.partnerApplication.update({
          where: { id },
          data: {
            status: nextStatus,
            venueId,
            version: { increment: 1 },
            events: {
              create: {
                actorUserId: adminId,
                fromStatus: app.status,
                toStatus: nextStatus,
                note:
                  dto.note?.trim() ||
                  (dto.action === 'approve'
                    ? 'Approved'
                    : dto.action === 'suspend'
                      ? 'Suspended'
                      : null),
              },
            },
          },
          include: {
            owner: {
              select: {
                id: true,
                name: true,
                email: true,
                username: true,
                phone: true,
              },
            },
            venue: { select: { id: true, slug: true, status: true } },
            events: { orderBy: { createdAt: 'desc' }, take: 20 },
          },
        });
      });
    } catch (err) {
      if (err instanceof HttpException) throw err;
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        'PUBLISH_FAILED',
        this.humanizePublishError(err),
      );
    }

    if (dto.action === 'approve' && updated.venueId) {
      await this.venues.refreshVenuePriceFrom(updated.venueId);
    }

    await this.notifyDecision(app.ownerId, id, dto.action, dto.note);
    return this.toAdminDto(updated);
  }

  latestForOwner(ownerId: string) {
    return this.prisma.partnerApplication.findFirst({
      where: { ownerId },
      orderBy: { updatedAt: 'desc' },
      include: { events: { orderBy: { createdAt: 'desc' }, take: 8 } },
    });
  }

  private statusForAction(
    action: PartnerDecisionDto['action'],
  ): PartnerApplicationStatus {
    switch (action) {
      case 'approve':
        return 'approved';
      case 'reject':
        return 'rejected';
      case 'request_changes':
        return 'changes_requested';
      case 'suspend':
        return 'suspended';
    }
  }

  private assertDecisionAllowed(
    status: PartnerApplicationStatus,
    action: PartnerDecisionDto['action'],
  ) {
    const allowed: Record<
      PartnerDecisionDto['action'],
      PartnerApplicationStatus[]
    > = {
      approve: ['pending', 'suspended'],
      reject: ['pending'],
      request_changes: ['pending', 'suspended'],
      suspend: ['approved'],
    };
    if (!allowed[action].includes(status)) {
      throw new ApiException(
        HttpStatus.CONFLICT,
        'INVALID_DECISION',
        `Cannot ${action.replace('_', ' ')} an application in status ${status}`,
      );
    }
  }

  private async publishVenue(
    tx: Prisma.TransactionClient,
    adminId: string,
    ownerId: string,
    payload: PartnerApplicationPayload,
    existingVenueId: string | null,
  ): Promise<string> {
    const countryCode = normalizeCountryCode(payload.countryCode) ?? 'EG';
    const lat = payload.lat;
    const lng = payload.lng;
    if (
      lat == null ||
      lng == null ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lng)
    ) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        'INVALID_LOCATION',
        'A confirmed map location is required before publishing',
      );
    }
    const cancellationPolicy =
      payload.cancellationPreset && payload.cancellationPreset !== 'custom'
        ? CANCELLATION_PRESETS[payload.cancellationPreset]
        : payload.cancellationPolicy;

    const venueData = {
      ownerId,
      countryCode,
      nameEn: payload.publicNameEn!,
      nameAr: payload.publicNameAr!,
      descriptionEn: payload.descriptionEn,
      descriptionAr: payload.descriptionAr,
      governorateId: payload.governorateId,
      districtId: payload.districtId,
      address: payload.address,
      lat,
      lng,
      geohash: encodeGeohash(lat, lng),
      instantBook: true,
      cancellationPolicy,
      weeklyHours: payload.weeklyHours as unknown as Prisma.InputJsonValue,
      contactPhone: payload.contactPhone,
      legalBusinessName: payload.legalBusinessName,
      registrationNumber: payload.registrationNumber,
      houseRules: payload.houseRules,
      status: 'active' as VenueStatus,
      approvedById: adminId,
      approvedAt: new Date(),
    };

    let venueId = existingVenueId;
    if (venueId) {
      await tx.venue.update({ where: { id: venueId }, data: venueData });
      await tx.venuePhoto.deleteMany({ where: { venueId } });
      await tx.venueSport.deleteMany({ where: { venueId } });
      await tx.venueAmenity.deleteMany({ where: { venueId } });
    } else {
      const slug = await this.uniqueSlug(
        tx,
        countryCode,
        payload.publicNameEn!,
      );
      const venue = await tx.venue.create({
        data: { ...venueData, slug },
      });
      venueId = venue.id;
    }

    const sportIds = Array.from(
      new Set(
        (payload.courts ?? [])
          .map((c) => this.normalizeSportId(c.sportId))
          .filter(Boolean),
      ),
    ) as string[];
    if (sportIds.length) {
      await tx.venueSport.createMany({
        data: sportIds.map((sportId) => ({ venueId: venueId, sportId })),
        skipDuplicates: true,
      });
    }

    const amenityKeys = Array.from(
      new Set((payload.courts ?? []).flatMap((c) => c.amenityKeys ?? [])),
    );
    if (amenityKeys.length) {
      const amenities = await tx.amenity.findMany({
        where: { key: { in: amenityKeys } },
      });
      if (amenities.length) {
        await tx.venueAmenity.createMany({
          data: amenities.map((a) => ({ venueId: venueId, amenityId: a.id })),
          skipDuplicates: true,
        });
      }
    }

    const existingCourts = await tx.court.findMany({ where: { venueId } });
    const keepIds = new Set(
      (payload.courts ?? []).map((c) => c.id).filter(Boolean) as string[],
    );
    for (const court of existingCourts) {
      if (!keepIds.has(court.id)) {
        const live = await tx.booking.count({
          where: { courtId: court.id, status: { in: ['held', 'confirmed'] } },
        });
        if (live === 0) {
          await tx.pricingRule.deleteMany({ where: { courtId: court.id } });
          await tx.court.delete({ where: { id: court.id } });
        }
      }
    }

    for (const [index, draft] of (payload.courts ?? []).entries()) {
      const pricing = {
        base: draft.basePriceAmount ?? 0,
        peak: draft.peakPriceAmount ?? draft.basePriceAmount ?? 0,
      };
      const currency =
        (
          await tx.countryConfig.findUnique({
            where: { code: countryCode },
            select: { currency: true },
          })
        )?.currency ?? 'EGP';

      const sportId = this.normalizeSportId(draft.sportId);
      const sportCategory = sportId
        ? ((await tx.sportCategory.findUnique({
            where: { id: sportId },
            select: { id: true, activityKind: true },
          })) ??
          (await tx.sportCategory.findUnique({
            where: { slug: sportId.replace(/^sport-/, '') },
            select: { id: true, activityKind: true },
          })))
        : null;
      if (!sportCategory) {
        throw new ApiException(
          HttpStatus.BAD_REQUEST,
          'INVALID_SPORT',
          `Unknown sport on court ${index + 1}`,
        );
      }
      const { gamingConfig, tableConfig, ageRating } = buildActivityFields(
        sportCategory.activityKind,
        draft.spec,
      );

      let courtId = draft.id;
      if (courtId && existingCourts.some((c) => c.id === courtId)) {
        await tx.court.update({
          where: { id: courtId },
          data: {
            name: draft.name || `Court ${index + 1}`,
            sportId: sportCategory.id,
            surface: draft.surface,
            indoor: draft.indoor ?? false,
            format: draft.format,
            slotDurationMins: draft.slotDurationMins ?? 60,
            spec: (draft.spec as Prisma.InputJsonValue) ?? Prisma.JsonNull,
            gamingConfig:
              (gamingConfig as Prisma.InputJsonValue) ?? Prisma.JsonNull,
            tableConfig:
              (tableConfig as Prisma.InputJsonValue) ?? Prisma.JsonNull,
            ageRating: ageRating ?? null,
          },
        });
        await tx.pricingRule.deleteMany({ where: { courtId } });
      } else {
        const created = await tx.court.create({
          data: {
            venueId: venueId,
            name: draft.name || `Court ${index + 1}`,
            sportId: sportCategory.id,
            surface: draft.surface,
            indoor: draft.indoor ?? false,
            format: draft.format,
            slotDurationMins: draft.slotDurationMins ?? 60,
            spec: (draft.spec as Prisma.InputJsonValue) ?? Prisma.JsonNull,
            gamingConfig:
              (gamingConfig as Prisma.InputJsonValue) ?? Prisma.JsonNull,
            tableConfig:
              (tableConfig as Prisma.InputJsonValue) ?? Prisma.JsonNull,
            ageRating: ageRating ?? null,
          },
        });
        courtId = created.id;
      }

      await tx.pricingRule.createMany({
        data: [
          {
            courtId: courtId,
            label: 'base',
            daysOfWeek: [],
            startTime: '00:00',
            endTime: '23:59',
            priceAmount: pricing.base,
            currency,
            priority: 0,
          },
          ...(pricing.peak !== pricing.base
            ? [
                {
                  courtId: courtId,
                  label: 'peak',
                  daysOfWeek: [5, 6],
                  startTime: '17:00',
                  endTime: '22:00',
                  priceAmount: pricing.peak,
                  currency,
                  priority: 10,
                },
              ]
            : []),
        ],
      });
    }

    const photos = payload.photos ?? [];
    if (photos.length) {
      await tx.venuePhoto.createMany({
        data: photos.map((photo, position) => ({
          venueId: venueId,
          url: photo.url!,
          position: photo.isCover ? 0 : position + 1,
        })),
      });
    }

    return venueId;
  }

  private async uniqueSlug(
    tx: Prisma.TransactionClient,
    countryCode: string,
    nameEn: string,
  ) {
    const base = `${countryCode.toLowerCase()}-${
      nameEn
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .trim()
        .replace(/\s+/g, '-') || 'venue'
    }`;
    let slug = base;
    let n = 1;
    while (
      await tx.venue.findUnique({ where: { slug }, select: { id: true } })
    ) {
      n += 1;
      slug = `${base}-${n}`;
    }
    return slug;
  }

  private async notifyDecision(
    ownerId: string,
    applicationId: string,
    action: PartnerDecisionDto['action'],
    note?: string,
  ) {
    const copy: Record<
      PartnerDecisionDto['action'],
      { en: string; ar: string }
    > = {
      approve: { en: 'Your venue was approved', ar: 'تمت الموافقة على ملعبك' },
      reject: { en: 'Your application was rejected', ar: 'تم رفض طلبك' },
      request_changes: {
        en: 'Changes requested on your application',
        ar: 'مطلوب تعديلات على طلبك',
      },
      suspend: { en: 'Your listing was suspended', ar: 'تم إيقاف إعلانك' },
    };
    await this.notifications.create({
      userId: ownerId,
      category: 'bookings',
      titleEn: copy[action].en,
      titleAr: copy[action].ar,
      bodyEn: note,
      bodyAr: note,
      deepLink: `/partners/join?application=${applicationId}`,
    });
  }

  private namesFrom(payload: PartnerApplicationPayload) {
    return {
      publicNameEn: payload.publicNameEn?.trim() || 'Untitled venue',
      publicNameAr: payload.publicNameAr?.trim() || 'ملعب بدون اسم',
    };
  }

  private assertVersion(
    current: number,
    bodyVersion?: number,
    ifMatch?: string,
  ) {
    const expected =
      bodyVersion ??
      (ifMatch && /^\d+$/.test(ifMatch.trim())
        ? Number(ifMatch.trim())
        : undefined);
    if (expected != null && expected !== current) {
      throw new ApiException(
        HttpStatus.CONFLICT,
        'APPLICATION_VERSION_CONFLICT',
        'This application was updated elsewhere. Reload and retry.',
      );
    }
  }

  private async load(id: string) {
    const app = await this.prisma.partnerApplication.findUnique({
      where: { id },
    });
    if (!app) throw new NotFoundException('Application not found');
    return app;
  }

  private async loadOwned(id: string, ownerId: string) {
    const app = await this.load(id);
    if (app.ownerId !== ownerId) {
      throw new ForbiddenException('Not your application');
    }
    return app;
  }

  private async assertGeoAndSports(payload: PartnerApplicationPayload) {
    const countryCode = normalizeCountryCode(payload.countryCode) ?? 'EG';
    const sportIds = (payload.courts ?? [])
      .map((c) => this.normalizeSportId(c.sportId))
      .filter(Boolean) as string[];
    const sportSlugs = sportIds.map((id) => id.replace(/^sport-/, ''));
    const [governorate, district, sports] = await Promise.all([
      this.prisma.governorate.findUnique({
        where: { id: payload.governorateId! },
      }),
      this.prisma.district.findUnique({ where: { id: payload.districtId! } }),
      this.prisma.sportCategory.findMany({
        where: {
          OR: [{ id: { in: sportIds } }, { slug: { in: sportSlugs } }],
        },
      }),
    ]);
    if (!governorate || governorate.countryCode !== countryCode) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        'INVALID_AREA',
        'Governorate does not match the selected country',
      );
    }
    if (!district || district.governorateId !== governorate.id) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        'INVALID_AREA',
        'District does not belong to the selected governorate',
      );
    }
    const known = new Set(sports.map((s) => s.id));
    const slugs = new Set(sports.map((s) => s.slug));
    const missing = (payload.courts ?? []).filter((c) => {
      const id = this.normalizeSportId(c.sportId);
      if (!id) return true;
      return !known.has(id) && !slugs.has(id.replace(/^sport-/, ''));
    });
    if (missing.length) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        'INVALID_SPORT',
        'One or more courts reference an unknown sport',
      );
    }
  }

  private allowedActions(
    status: PartnerApplicationStatus,
    role: 'owner' | 'admin',
  ) {
    if (role === 'admin') {
      return {
        canAmend: [
          'pending',
          'changes_requested',
          'approved',
          'suspended',
        ].includes(status),
        canApprove: ['pending', 'suspended'].includes(status),
        canReject: status === 'pending',
        canRequestChanges: ['pending', 'suspended'].includes(status),
        canSuspend: status === 'approved',
      };
    }
    return {
      canSave: OWNER_EDITABLE.has(status),
      canSubmit: ['draft', 'changes_requested'].includes(status),
      canEditLive: status === 'approved',
    };
  }

  private toOwnerDto(row: {
    id: string;
    ownerId: string;
    venueId: string | null;
    status: PartnerApplicationStatus;
    version: number;
    payload: Prisma.JsonValue;
    publicNameEn: string;
    publicNameAr: string;
    contactPhone: string;
    countryCode: string;
    submittedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
    events: Array<{
      id: string;
      actorUserId: string;
      fromStatus: PartnerApplicationStatus;
      toStatus: PartnerApplicationStatus;
      note: string | null;
      createdAt: Date;
    }>;
  }) {
    const payload = row.payload as PartnerApplicationPayload;
    return {
      id: row.id,
      ownerId: row.ownerId,
      venueId: row.venueId,
      status: row.status,
      version: row.version,
      payload: {
        ...payload,
        verificationDocumentUrl: payload.verificationDocumentUrl
          ? payload.verificationDocumentUrl
          : undefined,
      },
      publicNameEn: row.publicNameEn,
      publicNameAr: row.publicNameAr,
      contactPhone: row.contactPhone,
      countryCode: row.countryCode,
      submittedAt: row.submittedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      history: row.events,
      allowedActions: this.allowedActions(row.status, 'owner'),
    };
  }

  private toAdminDto(
    row: Parameters<PartnersService['toOwnerDto']>[0] & {
      owner?: {
        id: string;
        name: string;
        email: string | null;
        username: string | null;
        phone?: string | null;
      };
      venue?: { id: string; slug?: string; status?: VenueStatus } | null;
    },
  ) {
    return {
      ...this.toOwnerDto(row),
      owner: row.owner,
      venue: row.venue ?? (row.venueId ? { id: row.venueId } : null),
      allowedActions: this.allowedActions(row.status, 'admin'),
    };
  }

  private normalizeSportId(id?: string | null): string | undefined {
    const value = (id ?? '').trim();
    if (!value) return undefined;
    return value.startsWith('sport-') ? value : `sport-${value}`;
  }

  private humanizePublishError(err: unknown): string {
    const raw = err instanceof Error ? err.message : String(err ?? '');
    const lower = raw.toLowerCase();
    if (lower.includes('foreign key') || lower.includes('p2003')) {
      return 'A court references an unknown sport, or the selected area is invalid.';
    }
    if (lower.includes('unique') || lower.includes('p2002')) {
      return 'A venue with this name already exists. Rename the listing and retry.';
    }
    if (lower.includes('null') && (lower.includes('lat') || lower.includes('lng'))) {
      return 'The map location is missing. Confirm the pin, then approve again.';
    }
    if (
      raw.length > 220 ||
      /prisma|invocation|postgres|sql/i.test(raw)
    ) {
      return 'Publishing failed because the listing data is incomplete or invalid. Review courts, photos, location and hours, then retry.';
    }
    return raw || 'Publishing failed. Review the listing and retry.';
  }
}
