import {
  ConflictException,
  ForbiddenException,
  GoneException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGatewayEmitter } from '../realtime/realtime-emitter.interface';
import { SetAvailabilityDto } from './dto/set-availability.dto';
import { PulseFeedQueryDto } from './dto/feed-query.dto';
import { paginateByCursor } from '../../common/pagination/cursor-pagination.dto';
import { pulseStatusFromOccupancy } from './pulse-status.util';

const CLAIM_HOLD_MS = 90 * 1000; // §19.4: "60-120 seconds"
const AVAILABILITY_TTL_MS: Record<string, number> = {
  now: 30 * 60 * 1000,
  tonight: 5 * 3_600_000,
  weekend: 2 * 86_400_000,
};

@Injectable()
export class PulseService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly emitter: RealtimeGatewayEmitter,
  ) {}

  // ---- Availability ----

  async myAvailability(userId: string) {
    const availability = await this.prisma.pulseAvailability.findUnique({
      where: { userId },
    });
    if (!availability || availability.status !== 'active') return null;
    if (availability.expiresAt <= new Date()) {
      await this.prisma.pulseAvailability.update({
        where: { userId },
        data: { status: 'expired' },
      });
      return null;
    }
    return availability;
  }

  async setAvailability(userId: string, dto: SetAvailabilityDto) {
    const now = new Date();
    const ttl = AVAILABILITY_TTL_MS[dto.window] ?? AVAILABILITY_TTL_MS.now;

    const availability = await this.prisma.pulseAvailability.upsert({
      where: { userId },
      update: {
        window: dto.window,
        sportId: dto.sportId,
        mode: dto.mode,
        radiusKm: dto.radiusKm,
        maxBudgetAmount: dto.maxBudgetAmount,
        startsAt: now,
        expiresAt: new Date(now.getTime() + ttl),
        status: 'active',
        version: { increment: 1 },
      },
      create: {
        userId,
        window: dto.window,
        sportId: dto.sportId,
        mode: dto.mode,
        radiusKm: dto.radiusKm,
        maxBudgetAmount: dto.maxBudgetAmount,
        startsAt: now,
        expiresAt: new Date(now.getTime() + ttl),
      },
    });

    this.emitter.emitToRoom('pulse', {
      type: 'pulse.availability.changed',
      userId,
    });
    return availability;
  }

  async clearAvailability(userId: string): Promise<void> {
    await this.prisma.pulseAvailability.updateMany({
      where: { userId },
      data: { status: 'cancelled' },
    });
    this.emitter.emitToRoom('pulse', {
      type: 'pulse.availability.changed',
      userId,
    });
  }

  // ---- Feed ----

  async feed(userId: string, query: PulseFeedQueryDto) {
    const now = new Date();
    const [currentUser, friendships, blocks] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { countryCode: true },
      }),
      this.prisma.friendship.findMany({
        where: {
          status: 'accepted',
          OR: [{ requesterId: userId }, { addresseeId: userId }],
        },
        select: { requesterId: true, addresseeId: true },
      }),
      this.prisma.userBlock.findMany({
        where: { OR: [{ blockerId: userId }, { blockedId: userId }] },
        select: { blockerId: true, blockedId: true },
      }),
    ]);
    const friendIds = friendships.map((friendship) =>
      friendship.requesterId === userId
        ? friendship.addresseeId
        : friendship.requesterId,
    );
    const blockedIds = blocks.map((block) =>
      block.blockerId === userId ? block.blockedId : block.blockerId,
    );
    const visibleReadyWhere: Prisma.PulseAvailabilityWhereInput = {
      userId: { notIn: [userId, ...blockedIds] },
      status: 'active',
      expiresAt: { gt: now },
      ...(currentUser?.countryCode
        ? { user: { countryCode: currentUser.countryCode } }
        : {}),
      ...(query.sportId ? { sportId: query.sportId } : {}),
    };
    const readyWhere: Prisma.PulseAvailabilityWhereInput =
      query.scope === 'friends'
        ? { AND: [visibleReadyWhere, { userId: { in: friendIds } }] }
        : visibleReadyWhere;
    const where: Prisma.PulseOpportunityWhereInput = {
      status: { in: ['open', 'held'] },
      expiresAt: { gt: now },
      ...(query.sportId ? { sportId: query.sportId } : {}),
      ...(query.scope === 'rescue' ? { kind: 'rescue' } : {}),
    };

    const [page, readyPlayers, readyNearby, rescueSpots] = await Promise.all([
      paginateByCursor(
        (args) =>
          this.prisma.pulseOpportunity.findMany({
            where,
            orderBy: { id: 'desc' },
            include: { claims: true, sport: true },
            ...args,
          }),
        query.limit,
        query.cursor,
      ),
      query.scope === 'rescue'
        ? Promise.resolve([])
        : this.prisma.pulseAvailability.findMany({
            where: readyWhere,
            orderBy: { startsAt: 'desc' },
            take: 50,
            include: {
              sport: {
                select: { id: true, slug: true, nameEn: true, nameAr: true },
              },
              user: {
                select: {
                  id: true,
                  name: true,
                  avatarUrl: true,
                  reliabilityPct: true,
                  sportSkills: { select: { sportId: true, tier: true } },
                },
              },
            },
          }),
      this.prisma.pulseAvailability.count({ where: visibleReadyWhere }),
      this.prisma.pulseOpportunity.count({
        where: {
          kind: 'rescue',
          status: { in: ['open', 'held'] },
          expiresAt: { gt: now },
        },
      }),
    ]);

    return {
      items: page.items.map((o) => this.toDto(o, userId, new Set(friendIds))),
      readyPlayers: readyPlayers.map((availability) => ({
        userId: availability.user.id,
        name: availability.user.name,
        avatarUrl: availability.user.avatarUrl,
        reliabilityPct: availability.user.reliabilityPct,
        sportId: availability.sportId,
        sportSlug: availability.sport.slug,
        sportNameEn: availability.sport.nameEn,
        sportNameAr: availability.sport.nameAr,
        skillTier:
          availability.user.sportSkills.find(
            (skill) => skill.sportId === availability.sportId,
          )?.tier ?? null,
        window: availability.window,
        mode: availability.mode,
        radiusKm: availability.radiusKm,
        maxBudgetAmount: availability.maxBudgetAmount,
        currency: availability.currency,
        expiresAt: availability.expiresAt,
        isFriend: friendIds.includes(availability.userId),
      })),
      nextCursor: page.nextCursor,
      metrics: { readyNearby, rescueSpots, averageFillMinutes: null },
      serverTime: new Date().toISOString(),
    };
  }

  private toDto(
    opportunity: any,
    userId: string,
    friendIds: ReadonlySet<string> = new Set(),
  ) {
    const activeClaims = opportunity.claims.filter((c: any) =>
      ['held', 'confirmed'].includes(c.state),
    );
    return {
      id: opportunity.id,
      kind: opportunity.kind,
      status: opportunity.status,
      sportId: opportunity.sportId,
      mode: opportunity.mode,
      skillTier: opportunity.skillTier,
      startsAt: opportunity.startsAt,
      expiresAt: opportunity.expiresAt,
      costPerPlayerAmount: opportunity.costPerPlayerAmount,
      originalCostPerPlayerAmount: opportunity.originalCostPerPlayerAmount,
      currency: opportunity.currency,
      capacity: opportunity.capacity,
      joinedCount: activeClaims.length,
      reliabilityFloor: opportunity.reliabilityFloor,
      urgent: opportunity.urgent,
      claimedByMe: activeClaims.some((c: any) => c.userId === userId),
      friendsCount: activeClaims.filter((claim: any) =>
        friendIds.has(claim.userId),
      ).length,
      version: opportunity.version,
      reason:
        opportunity.kind === 'rescue'
          ? 'A match near you needs one more player'
          : 'Matches your availability',
    };
  }

  async getOpportunity(userId: string, id: string) {
    const [opportunity, friendships] = await Promise.all([
      this.prisma.pulseOpportunity.findUnique({
        where: { id },
        include: { claims: true },
      }),
      this.prisma.friendship.findMany({
        where: {
          status: 'accepted',
          OR: [{ requesterId: userId }, { addresseeId: userId }],
        },
        select: { requesterId: true, addresseeId: true },
      }),
    ]);
    if (!opportunity) throw new NotFoundException('Opportunity not found');
    const friendIds = new Set(
      friendships.map((friendship) =>
        friendship.requesterId === userId
          ? friendship.addresseeId
          : friendship.requesterId,
      ),
    );
    return this.toDto(opportunity, userId, friendIds);
  }

  // ---- Claim state machine (§19.4) ----

  async claim(userId: string, opportunityId: string) {
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const opportunity = await tx.pulseOpportunity.findUnique({
            where: { id: opportunityId },
          });
          if (!opportunity)
            throw new NotFoundException('Opportunity not found');
          if (opportunity.expiresAt < new Date())
            throw new GoneException('PULSE_EXPIRED');
          if (!['open', 'held'].includes(opportunity.status))
            throw new ConflictException('PULSE_CAPACITY_CHANGED');

          const activeCount = await tx.pulseClaim.count({
            where: { opportunityId, state: { in: ['held', 'confirmed'] } },
          });
          if (activeCount >= opportunity.capacity)
            throw new ConflictException('PULSE_CAPACITY_CHANGED');

          const claim = await tx.pulseClaim.create({
            data: {
              opportunityId,
              userId,
              state: 'held',
              holdExpiresAt: new Date(Date.now() + CLAIM_HOLD_MS),
            },
          });

          const newStatus = pulseStatusFromOccupancy(
            opportunity.capacity,
            activeCount + 1,
          );
          await tx.pulseOpportunity.update({
            where: { id: opportunityId },
            data: { status: newStatus, version: { increment: 1 } },
          });

          return claim;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2034'
      ) {
        throw new ConflictException('PULSE_CAPACITY_CHANGED'); // serialization conflict — someone else won the race
      }
      throw error;
    }
  }

  async releaseClaim(userId: string, opportunityId: string) {
    const claim = await this.prisma.pulseClaim.findUnique({
      where: { opportunityId_userId: { opportunityId, userId } },
    });
    if (!claim) throw new NotFoundException('Claim not found');
    if (!claim.userId || claim.userId !== userId)
      throw new ForbiddenException('Not your claim');

    await this.prisma.$transaction(async (tx) => {
      await tx.pulseClaim.update({
        where: { id: claim.id },
        data: { state: 'released' },
      });
      const opportunity = await tx.pulseOpportunity.findUnique({
        where: { id: opportunityId },
      });
      if (
        opportunity &&
        ['open', 'held', 'full'].includes(opportunity.status)
      ) {
        const activeCount = await tx.pulseClaim.count({
          where: {
            opportunityId,
            state: { in: ['held', 'confirmed'] },
          },
        });
        await tx.pulseOpportunity.update({
          where: { id: opportunityId },
          data: {
            status: pulseStatusFromOccupancy(opportunity.capacity, activeCount),
            version: { increment: 1 },
          },
        });
      }
    });
  }

  confirmClaim(claimId: string) {
    return this.prisma.pulseClaim.update({
      where: { id: claimId },
      data: { state: 'confirmed' },
    });
  }
}
