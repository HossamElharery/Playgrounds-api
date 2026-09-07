import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  PAYMENT_PROVIDER,
  PaymentProvider,
} from '../payments/payment-provider.interface';
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
 * §7.6 backend note, followed literally here: there is no real PSP
 * subscription/recurring-charge integration in this repo (PaymentProvider is
 * one-shot charge/refund only, see payments module). This service is the
 * documented "manually-renewed record" mock the blueprint explicitly allows
 * for now — `subscribe` does one real (mock) charge and opens a 30-day
 * period; renewal is via `POST /membership/webhooks/renewal`, a stand-in for
 * a real PSP webhook, guarded by a shared secret rather than a verified
 * signature. Swapping in a real PSP subscription object as the source of
 * truth for `status` is the TODO called out in the blueprint — do it here
 * and in payments module, BookingsService should not need to change.
 */
@Injectable()
export class MembershipService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(PAYMENT_PROVIDER) private readonly paymentProvider: PaymentProvider,
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

    const charge = await this.paymentProvider.charge(
      plan.priceAmount,
      plan.priceCurrency,
      dto.paymentMethod,
    );
    if (charge.status === 'failed')
      throw new BadRequestException('PAYMENT_FAILED');

    const now = new Date();
    const periodEnd = new Date(now.getTime() + PERIOD_DAYS * 86_400_000);
    const membership = await this.prisma.userMembership.upsert({
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
