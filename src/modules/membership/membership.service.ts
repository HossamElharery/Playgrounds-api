import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../payments/wallet.service';
import { RealtimeGatewayEmitter } from '../realtime/realtime-emitter.interface';
import {
  CreateMembershipPlanDto,
  SubscribeMembershipDto,
  UpdateMembershipPlanDto,
} from './dto/membership.dto';

const PERIOD_DAYS = 30;

/**
 * Membership / subscription tier (§3.8/§7.3), additive to the coins economy.
 *
 * Player subscribe debits the prepaid EGP wallet. PSP methods are wallet
 * top-up only. There is still no live PSP recurring-billing integration —
 * `POST /membership/webhooks/renewal` remains the mock renewal stand-in.
 */
@Injectable()
export class MembershipService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
    private readonly emitter: RealtimeGatewayEmitter,
  ) {}

  listPlans(includeInactive = false) {
    return this.prisma.membershipPlan.findMany({
      where: includeInactive ? {} : { active: true },
      orderBy: { priceAmount: 'asc' },
    });
  }

  createPlan(dto: CreateMembershipPlanDto) {
    return this.prisma.membershipPlan.create({
      data: {
        slug: dto.slug,
        nameEn: dto.nameEn,
        nameAr: dto.nameAr,
        scope: dto.scope,
        priceAmount: dto.priceAmount,
        priceCurrency: dto.priceCurrency ?? 'EGP',
        includedHours: dto.includedHours,
        overageDiscountPercent: dto.overageDiscountPercent ?? 0,
        perksEn: dto.perksEn ?? [],
        perksAr: dto.perksAr ?? [],
      },
    });
  }

  async updatePlan(id: string, dto: UpdateMembershipPlanDto) {
    const plan = await this.prisma.membershipPlan.findUnique({ where: { id } });
    if (!plan) throw new NotFoundException('Plan not found');
    return this.prisma.membershipPlan.update({ where: { id }, data: dto });
  }

  async me(userId: string) {
    return this.prisma.userMembership.findUnique({
      where: { userId },
      include: { plan: true },
    });
  }

  async subscribe(userId: string, dto: SubscribeMembershipDto) {
    const plan = await this.prisma.membershipPlan.findUnique({
      where: { id: dto.planId },
    });
    if (!plan || !plan.active) throw new NotFoundException('Plan not found');

    const existing = await this.prisma.userMembership.findUnique({
      where: { userId },
    });
    if (existing && existing.status === 'active') {
      throw new BadRequestException('Already has an active membership');
    }

    const now = new Date();
    const periodEnd = new Date(now.getTime() + PERIOD_DAYS * 86_400_000);

    const membership = await this.prisma.$transaction(async (tx) => {
      await this.wallet.debit(tx, {
        userId,
        amount: plan.priceAmount,
        reason: 'membership',
      });
      return tx.userMembership.upsert({
        where: { userId },
        update: {
          planId: plan.id,
          status: 'active',
          currentPeriodStart: now,
          currentPeriodEnd: periodEnd,
          hoursUsedThisPeriod: 0,
          cancelledAt: null,
        },
        create: {
          userId,
          planId: plan.id,
          status: 'active',
          currentPeriodStart: now,
          currentPeriodEnd: periodEnd,
        },
        include: { plan: true },
      });
    });
    this.emitter.emitToUser(userId, {
      type: 'membership.status.changed',
      userId,
      status: membership.status,
    });
    return membership;
  }

  async cancel(userId: string) {
    const membership = await this.prisma.userMembership.findUnique({
      where: { userId },
    });
    if (!membership) throw new NotFoundException('No membership to cancel');
    const updated = await this.prisma.userMembership.update({
      where: { userId },
      data: { status: 'cancelled', cancelledAt: new Date() },
      include: { plan: true },
    });
    this.emitter.emitToUser(userId, {
      type: 'membership.status.changed',
      userId,
      status: updated.status,
    });
    return updated;
  }

  /**
   * Mock renewal webhook — see class doc. `sharedSecret` stands in for a
   * verified PSP signature; wrong/missing secret is rejected the same way a
   * bad webhook signature would be.
   */
  async handleRenewalWebhook(userId: string, success: boolean) {
    const membership = await this.prisma.userMembership.findUnique({
      where: { userId },
    });
    if (!membership) throw new NotFoundException('No membership found');

    if (!success) {
      const updated = await this.prisma.userMembership.update({
        where: { userId },
        data: { status: 'past_due' },
      });
      this.emitter.emitToUser(userId, {
        type: 'membership.status.changed',
        userId,
        status: updated.status,
      });
      return updated;
    }

    const now = new Date();
    const updated = await this.prisma.userMembership.update({
      where: { userId },
      data: {
        status: 'active',
        currentPeriodStart: now,
        currentPeriodEnd: new Date(now.getTime() + PERIOD_DAYS * 86_400_000),
        hoursUsedThisPeriod: 0,
      },
    });
    this.emitter.emitToUser(userId, {
      type: 'membership.status.changed',
      userId,
      status: updated.status,
    });
    return updated;
  }
}
