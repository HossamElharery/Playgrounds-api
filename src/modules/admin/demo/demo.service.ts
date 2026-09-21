import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import * as ngeohash from 'ngeohash';
import { PrismaService } from '../../prisma/prisma.service';
import { LedgerService } from '../../finance/ledger.service';
import { addDays, sessionWindow, zonedDate, weekdayOfLocalDate } from '../../../common/utils/fixed-series.util';
import { NODE_ENV_IS_PRODUCTION } from './demo.constants';

const TZ = 'Africa/Cairo';
const HISTORY_DAYS = 70;
const COMMISSION_BPS = 1000;

/** Small deterministic PRNG so a demo looks the same every time it is (re)generated. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const CUSTOMERS = ['الأهلي', 'الزمالك', 'أحمد سمير', 'محمد علي', 'كريم فتحي', 'يوسف عادل', 'عمر خالد', 'زياد مصطفى', 'مصطفى رضا', 'إبراهيم سعيد'];
const SOURCES = ['walk_in', 'phone', 'whatsapp'] as const;

/**
 * Sales demo: one clearly-flagged venue with realistic data that lights up every owner screen
 * (fixed bookings, idle hours for discount suggestions, part payments, expenses, team, a request
 * to Matchena, a subscription about to end). It is `isDemo` AND `pending`, so every public query
 * (which asks for `active`) and every real figure (which asks for `isDemo = false`) skips it.
 */
@Injectable()
export class DemoService {
  private readonly logger = new Logger(DemoService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
  ) {}

  async list() {
    const venues = await this.prisma.venue.findMany({
      where: { isDemo: true },
      select: { id: true, nameEn: true, nameAr: true, createdAt: true, owner: { select: { email: true } }, _count: { select: { bookings: true, courts: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return venues.map((v) => ({
      venueId: v.id,
      nameEn: v.nameEn,
      nameAr: v.nameAr,
      ownerEmail: v.owner.email,
      bookings: v._count.bookings,
      courts: v._count.courts,
      createdAt: v.createdAt.toISOString(),
    }));
  }

  /** Builds a fresh demo. The owner password is generated here and returned exactly once. */
  async create(adminId: string, opts: { seedKey?: number } = {}) {
    if (NODE_ENV_IS_PRODUCTION() && process.env.ALLOW_DEMO_IN_PRODUCTION !== 'true') {
      throw new BadRequestException('Demo venues are disabled in production');
    }
    const tag = randomBytes(3).toString('hex');
    const password = randomBytes(9).toString('base64url');
    const passwordHash = await bcrypt.hash(password, 10);
    const now = new Date();
    const admin = await this.prisma.user.findUnique({ where: { id: adminId }, select: { id: true } });
    if (!admin) throw new NotFoundException('Admin not found');

    const sports = await this.prisma.sportCategory.findMany({ where: { id: { in: ['sport-padel', 'sport-football-5', 'sport-tennis'] } } });
    if (sports.length < 3) throw new BadRequestException('Sports catalogue is missing — run the seed first');
    const country = await this.prisma.countryConfig.findUnique({ where: { code: 'EG' } });
    if (!country) throw new BadRequestException('Country EG is missing — run the seed first');

    let venueId = '';
    try {
      const owner = await this.prisma.user.create({
        data: { email: `demo+${tag}@matchena.invalid`, emailVerifiedAt: now, passwordHash, name: 'Demo Owner', username: `demo${tag}`, roles: ['owner'], isDemo: true, countryCode: 'EG' },
      });
      const player = await this.prisma.user.create({
        data: { email: `demo-player+${tag}@matchena.invalid`, emailVerifiedAt: now, name: 'Demo Player', roles: ['player'], isDemo: true, countryCode: 'EG' },
      });
      const slug = `demo-${tag}`;
      const venue = await this.prisma.venue.create({
        data: {
          slug,
          ownerId: owner.id,
          countryCode: 'EG',
          nameEn: `DEMO · Cairo Padel Club ${tag}`,
          nameAr: `تجريبي · نادي القاهرة للبادل ${tag}`,
          lat: 30.0444,
          lng: 31.2357,
          geohash: ngeohash.encode(30.0444, 31.2357, 9),
          status: 'pending', // never public
          isDemo: true,
          priceFromAmount: 30000,
          priceFromCurrency: 'EGP',
          paymentMode: 'at_venue',
          weeklyHours: Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), { open: '09:00', close: '24:00' }])),
          subscription: { create: { currentPeriodEnd: new Date(now.getTime() + 5 * 86_400_000), notes: 'DEMO' } },
        },
      });
      venueId = venue.id;

      const courts = [] as { id: string; name: string }[];
      for (const [i, sport] of sports.entries()) {
        const court = await this.prisma.court.create({
          data: { venueId, sportId: sport.id, name: `${['Padel 1', 'Football 5v5', 'Tennis 1'][i]}`, slotDurationMins: 60 },
        });
        await this.prisma.pricingRule.createMany({
          data: [
            { courtId: court.id, label: 'base', daysOfWeek: [], startTime: '09:00', endTime: '24:00', priceAmount: 30000 + i * 10000, priority: 0 },
            { courtId: court.id, label: 'peak', daysOfWeek: [], startTime: '18:00', endTime: '23:00', priceAmount: 45000 + i * 10000, priority: 10 },
          ],
        });
        courts.push({ id: court.id, name: court.name });
      }

      await this.history(venueId, owner.id, player.id, courts, opts.seedKey ?? tag.charCodeAt(0));
      await this.fixedSeries(venueId, owner.id, courts[0].id);
      await this.expensesAndTeam(venueId, owner.id, admin.id);
      await this.discountAndRequest(venueId, owner.id, player.id, courts);
      await this.syncLedger(venueId);
      await this.prisma.auditLogEntry.create({ data: { actorUserId: adminId, action: 'demo.created', targetType: 'venue', targetId: venueId } });
      return { venueId, ownerEmail: owner.email, password, note: 'The password is shown once. Open the venue as owner from the admin, or log in with it.' };
    } catch (err) {
      this.logger.error(`Demo creation failed, rolling back: ${String(err)}`);
      if (venueId) await this.remove(adminId, venueId).catch(() => undefined);
      throw err;
    }
  }

  /** Wipes a demo venue and everything that belongs to it, then builds it again (dates relative to today). */
  async reset(adminId: string, venueId: string) {
    const venue = await this.loadDemo(venueId);
    await this.remove(adminId, venueId);
    void venue;
    return this.create(adminId);
  }

  /** Deletes the venue, its data and the fake accounts. Refuses anything that is not a demo. */
  async remove(adminId: string, venueId: string) {
    const venue = await this.loadDemo(venueId);
    const ownerId = venue.ownerId;
    const staff = await this.prisma.staffMember.findMany({ where: { ownerId }, select: { userId: true } });
    await this.prisma.$transaction(
      async (tx) => {
        await tx.payment.deleteMany({ where: { booking: { venueId } } });
        await tx.venueLedgerEntry.deleteMany({ where: { venueId } });
        await tx.venueSettlement.deleteMany({ where: { venueId } });
        await tx.platformBookingRequest.deleteMany({ where: { venueId } });
        await tx.recurringBookingSeries.deleteMany({ where: { venueId } });
        await tx.booking.deleteMany({ where: { venueId } });
        await tx.pricingDiscount.deleteMany({ where: { venueId } });
        await tx.venueExpense.deleteMany({ where: { venueId } });
        await tx.staffMember.deleteMany({ where: { ownerId } });
        await tx.venue.delete({ where: { id: venueId } });
        const fakeIds = [ownerId, ...staff.map((s) => s.userId)];
        await tx.refreshToken.deleteMany({ where: { userId: { in: fakeIds } } });
        await tx.notification.deleteMany({ where: { userId: { in: fakeIds } } });
        await tx.user.deleteMany({ where: { isDemo: true, OR: [{ id: { in: fakeIds } }, { email: { startsWith: `demo-player+${venue.slug.replace('demo-', '')}` } }] } });
        await tx.auditLogEntry.create({ data: { actorUserId: adminId, action: 'demo.deleted', targetType: 'venue', targetId: venueId } });
      },
      { timeout: 60_000 },
    );
    return { ok: true };
  }

  // ---- generators ---------------------------------------------------------

  private async history(venueId: string, ownerId: string, playerId: string, courts: { id: string }[], seed: number) {
    const rand = rng(seed);
    const today = zonedDate(new Date(), TZ);
    const rows: Prisma.BookingCreateManyInput[] = [];
    const payments: Prisma.PaymentCreateManyInput[] = [];
    let n = 0;
    const code = (p: string) => `DEMO-${p}${(++n).toString(36).toUpperCase()}${randomBytes(2).toString('hex').toUpperCase()}`;

    for (let d = -HISTORY_DAYS; d <= 7; d++) {
      const date = addDays(today, d);
      const weekday = weekdayOfLocalDate(date);
      for (const [ci, court] of courts.entries()) {
        for (let hour = 16; hour <= 23; hour++) {
          // Thursday/Friday evenings are busy; court 1 is deliberately EMPTY on Sunday 14:00-16:00-ish
          // (nothing before 18:00 on Sundays) so the idle-hours suggestion has something to say.
          const peak = hour >= 18 && hour <= 22;
          if (weekday === 0 && ci === 0 && hour < 18) continue;
          const chance = (peak ? 0.62 : 0.2) + (weekday === 4 || weekday === 5 ? 0.22 : 0) - (weekday === 0 || weekday === 1 ? 0.15 : 0);
          if (rand() > chance) continue;
          const { start, end } = sessionWindow(date, `${String(hour).padStart(2, '0')}:00`, 60, TZ);
          const price = (peak ? 45000 : 30000) + ci * 10000;
          const past = end.getTime() < Date.now();
          const platform = rand() < 0.4;
          const base = {
            courtId: court.id,
            venueId,
            slotStart: start,
            slotEnd: end,
            currency: 'EGP',
            createdAt: past ? new Date(start.getTime() - 3 * 86_400_000) : new Date(),
          };
          if (platform) {
            const commission = Math.round((price * COMMISSION_BPS) / 10_000);
            rows.push({
              ...base,
              code: code('M'),
              userId: playerId,
              baseAmount: price,
              feeAmount: 0,
              discountAmount: 0,
              totalAmount: price,
              status: past ? 'completed' : 'confirmed',
              paymentStatus: past ? 'paid' : 'pending',
              paymentMethod: 'cash',
              source: 'platform',
              paymentModeSnapshot: 'at_venue',
              commissionBps: COMMISSION_BPS,
              commissionAmount: commission,
              ownerNetAmount: price - commission,
              checkedInAt: past ? start : null,
            });
          } else {
            const roll = rand();
            const name = CUSTOMERS[Math.floor(rand() * CUSTOMERS.length)];
            // Past: mostly paid, a few still owed. Near future: some unpaid, one partial.
            const paid = past ? roll < 0.86 : roll < 0.25;
            const partial = !paid && roll > 0.9;
            const id = crypto.randomUUID();
            rows.push({
              ...base,
              id,
              code: code('O'),
              userId: ownerId,
              baseAmount: price,
              feeAmount: 0,
              discountAmount: 0,
              totalAmount: price,
              status: past ? 'completed' : 'confirmed',
              paymentStatus: paid ? 'paid' : partial ? 'partial' : 'pending',
              paymentMethod: rand() < 0.75 ? 'cash' : 'instapay',
              source: 'manual',
              sourceKey: SOURCES[Math.floor(rand() * SOURCES.length)],
              guestName: name,
              createdByUserId: ownerId,
            });
            if (paid || partial) {
              payments.push({ bookingId: id, amount: paid ? price : Math.round(price / 3), currency: 'EGP', method: 'cash', status: 'paid' });
            }
          }
        }
      }
    }
    for (let i = 0; i < rows.length; i += 500) await this.prisma.booking.createMany({ data: rows.slice(i, i + 500) });
    for (let i = 0; i < payments.length; i += 500) await this.prisma.payment.createMany({ data: payments.slice(i, i + 500) });
  }

  private async fixedSeries(venueId: string, ownerId: string, courtId: string) {
    const today = zonedDate(new Date(), TZ);
    // "Al Ahly every Thursday 20:00" and "Zamalek every Sunday 21:00" — booked from 4 weeks ago, 8 weeks ahead.
    for (const [name, weekday, hhmm] of [['الأهلي', 4, '20:00'], ['الزمالك', 0, '21:00']] as const) {
      let first = addDays(today, -28);
      while (weekdayOfLocalDate(first) !== weekday) first = addDays(first, 1);
      const series = await this.prisma.recurringBookingSeries.create({
        data: { courtId, venueId, kind: 'manual', dayOfWeek: weekday, startTime: hhmm, durationMins: 60, customerName: name, paymentPlan: 'per_session', startDate: first, until: addDays(first, 12 * 7), sourceKey: 'phone', createdByUserId: ownerId },
      });
      for (let i = 0; i < 12; i++) {
        const { start, end } = sessionWindow(addDays(first, i * 7), hhmm, 60, TZ);
        const clash = await this.prisma.booking.findFirst({ where: { courtId, slotStart: { lt: end }, slotEnd: { gt: start }, status: { in: ['confirmed', 'completed'] } }, select: { id: true } });
        if (clash) continue;
        const past = end.getTime() < Date.now();
        const b = await this.prisma.booking.create({
          data: { code: `DEMO-F${weekday}${i}${randomBytes(2).toString('hex').toUpperCase()}`, courtId, venueId, userId: ownerId, slotStart: start, slotEnd: end, baseAmount: 45000, feeAmount: 0, discountAmount: 0, totalAmount: 45000, status: past ? 'completed' : 'confirmed', paymentStatus: past ? 'paid' : 'pending', paymentMethod: 'cash', source: 'manual', sourceKey: 'phone', guestName: name, createdByUserId: ownerId, recurringSeriesId: series.id },
        });
        if (past) await this.prisma.payment.create({ data: { bookingId: b.id, amount: 45000, currency: 'EGP', method: 'cash', status: 'paid' } });
      }
    }
  }

  private async expensesAndTeam(venueId: string, ownerId: string, adminId: string) {
    const today = zonedDate(new Date(), TZ);
    const first = addDays(today.slice(0, 8) + '01', -62);
    const rent = await this.prisma.venueExpense.create({ data: { venueId, category: 'rent', amount: 800000, incurredOn: first, recurringMonthly: true, createdById: ownerId } });
    void rent;
    await this.prisma.venueExpense.createMany({
      data: [
        { venueId, category: 'electricity', amount: 120000, incurredOn: addDays(today, -40), createdById: ownerId },
        { venueId, category: 'electricity', amount: 135000, incurredOn: addDays(today, -10), createdById: ownerId },
        { venueId, category: 'salaries', amount: 600000, incurredOn: addDays(today, -35), createdById: ownerId },
        { venueId, category: 'maintenance', amount: 45000, incurredOn: addDays(today, -20), note: 'شباك الملعب', createdById: ownerId },
      ],
    });
    const passwordHash = await bcrypt.hash(randomBytes(12).toString('hex'), 10);
    for (const [title, perms, tagName] of [
      ['Reception', ['bookings.view', 'bookings.create', 'bookings.checkin', 'payments.record', 'customers.view'], 'reception'],
      ['Accountant', ['bookings.view', 'payments.record', 'reports.view', 'expenses.manage', 'account.view'], 'accountant'],
    ] as const) {
      const user = await this.prisma.user.create({
        data: { email: `demo-${tagName}+${randomBytes(3).toString('hex')}@matchena.invalid`, emailVerifiedAt: new Date(), passwordHash, name: `Demo ${title}`, roles: ['staff'], isDemo: true, countryCode: 'EG' },
      });
      await this.prisma.staffMember.create({ data: { userId: user.id, ownerId, title, permissions: [...perms], venueIds: [venueId], createdById: adminId } });
    }
  }

  private async discountAndRequest(venueId: string, ownerId: string, playerId: string, courts: { id: string }[]) {
    // A discount applied 20 days ago on the quiet Sunday afternoon, so "measured result" has data.
    const court = courts[0];
    const now = new Date();
    const rule = await this.prisma.pricingRule.create({
      data: { courtId: court.id, label: 'discount', daysOfWeek: [0], startTime: '14:00', endTime: '16:00', priceAmount: 24000, priority: 20, kind: 'discount', source: 'suggestion', validFrom: new Date(now.getTime() - 20 * 86_400_000), validUntil: new Date(now.getTime() + 8 * 86_400_000) },
    });
    await this.prisma.pricingDiscount.create({
      data: { venueId, courtId: court.id, weekday: 0, startHour: 14, endHour: 16, percent: 20, status: 'active', source: 'suggestion', validFrom: rule.validFrom, validUntil: rule.validUntil, baselineOccupancy: 0.12, estimatedMonthlyLoss: 96000, ruleIds: [rule.id], createdById: ownerId },
    });
    const upcoming = await this.prisma.booking.findFirst({ where: { venueId, source: 'platform', status: 'confirmed', slotStart: { gt: now } }, orderBy: { slotStart: 'asc' } });
    if (upcoming) {
      await this.prisma.platformBookingRequest.create({
        data: { bookingId: upcoming.id, venueId, kind: 'change', reason: 'العميل طلب يأجّل ساعة', status: 'answered', adminReply: 'اتواصلنا مع اللاعب واتعدّل الميعاد.', resolvedAt: now, createdById: ownerId },
      });
    }
    void playerId;
  }

  private async syncLedger(venueId: string) {
    const platform = await this.prisma.booking.findMany({ where: { venueId, source: 'platform' }, select: { id: true } });
    for (const b of platform) {
      await this.prisma.$transaction((tx) => this.ledger.syncBookingLedger(tx, b.id));
    }
  }

  private async loadDemo(venueId: string) {
    const venue = await this.prisma.venue.findUnique({ where: { id: venueId }, select: { id: true, ownerId: true, slug: true, isDemo: true } });
    if (!venue) throw new NotFoundException('Venue not found');
    // Hard guard: this code path can never touch a real venue.
    if (!venue.isDemo) throw new BadRequestException('This is not a demo venue');
    return venue;
  }
}
