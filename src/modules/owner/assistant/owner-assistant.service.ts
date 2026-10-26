import {
  BadRequestException,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AiQuotaService } from '../../ai/ai-quota.service';
import { AiSettingsService } from '../../ai/ai-settings.service';
import { AiLogService } from '../../ai/ai-log.service';
import { AssistantTranscriptService } from '../../ai/transcript/assistant-transcript.service';
import { VenueAiCreditService, type CreditVerdict } from '../../ai/credit/venue-ai-credit.service';
import { OwnerBookingsService } from '../owner-bookings.service';
import { OwnerSummaryService } from '../owner-summary.service';
import { ExpensesService } from '../expenses/expenses.service';
import {
  AssistantNluService,
  type NluCourtRef,
  type NluKnownBooking,
  type NluTurn,
} from './assistant-nlu.service';
import {
  completeReading,
  hhmm,
  isAffirmative,
  joinBi,
  nextDay,
  normalizeName,
  sanitizeDraft,
  todayIn,
  courtDetails,
  refundIntent,
} from './assistant-reading';
import { listUnits } from './assistant-courts';
import { findAllOwed, findOwed, type OwedRow } from './assistant-attention';
import {
  bi,
  type AssistantAction,
  type AssistantBookingRef,
  type AssistantIssue,
  type AssistantPlan,
  type AssistantReading,
  type Bi,
} from './assistant.types';
import {
  fmtMoney as fmt,
  reconcileBookingMoney,
  toMinor,
} from './assistant-money';
import { assertVenueAccess } from '../../../common/access/owner-access';
import { loadStaffScope, scopeCan } from '../../../common/access/staff-scope';
import type { PermissionKey } from '../../../common/access/permissions';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.interface';
import { quoteDurationPrice } from '../../../common/utils/price-quote.util';
import { unitWords } from '../../../common/utils/unit-noun.util';
import {
  zonedHhmm,
  zonedWallTimeToUtc,
  zonedDayBounds,
} from '../../../common/utils/timezone.util';

const MIN_CONFIDENCE = 0.35;
const MIN_CONFIDENCE_WRITE = 0.6;
const WRITES_MONEY: ReadonlySet<AssistantReading['intent']> = new Set([
  'book',
  'pay',
  'cancel',
  'move',
  'expense',
]);

// Kept for the callers and specs that always imported them from here.
export { completeReading, isAffirmative, nextDay };

@Injectable()
export class OwnerAssistantService {
  private readonly logger = new Logger(OwnerAssistantService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly nlu: AssistantNluService,
    private readonly bookings: OwnerBookingsService,
    private readonly summary: OwnerSummaryService,
    private readonly expenses: ExpensesService,
    @Optional() private readonly quota?: AiQuotaService,
    @Optional() private readonly settings?: AiSettingsService,
    @Optional() private readonly logs?: AiLogService,
    @Optional() private readonly transcript?: AssistantTranscriptService,
    @Optional() private readonly credit?: VenueAiCreditService,
  ) {}

  get enabled(): boolean {
    return this.nlu.enabled;
  }

  async ask(
    user: AuthenticatedUser,
    venueId: string,
    text: string,
    extra: { history?: NluTurn[]; draft?: Record<string, unknown> } = {},
  ): Promise<AssistantPlan> {
    const trace: { limited?: boolean; detail?: string; meta?: AssistantReading['meta'] } = {};
    const plan = await this.plan(user, venueId, text, extra, trace);
    const blocking = plan.issues.find((i) => i.blocking);
    const outcome = trace.limited
      ? 'limited'
      : !plan.available
        ? 'unavailable'
        : blocking?.code === 'NO_PERMISSION'
          ? 'denied'
          : plan.intent === 'unknown'
            ? 'clarify'
            : 'planned';
    this.logs?.logOwnerEvent({
      venueId,
      userId: user.id,
      event: 'ask',
      text,
      intent: plan.intent,
      outcome,
      detail: trace.detail ?? blocking?.code,
      confidence: plan.confidence,
      model: trace.meta?.model ?? null,
      ms: trace.meta?.ms,
      costUsd: trace.meta?.costUsd,
    });
    if (this.transcript) {
      const reply = plan.reply.ar || plan.reply.en || plan.summary?.ar || '';
      void this.transcript.recordTurn({
        ownerId: user.id,
        ownerName: user.name,
        venueId,
        ownerText: text,
        replyText: plan.needsConfirm && reply ? `${reply}\n(بانتظار تأكيد صاحب المنشأة)` : reply,
        intent: plan.intent,
        outcome,
        confidence: plan.confidence,
        model: trace.meta?.model ?? null,
        blockingCode: blocking?.code,
        meta: plan.actions.length || plan.issues.length
          ? { needsConfirm: plan.needsConfirm, actions: plan.actions, issues: plan.issues.map((i) => i.code) }
          : undefined,
      });
    }
    return plan;
  }

  private async plan(
    user: AuthenticatedUser,
    venueId: string,
    text: string,
    extra: { history?: NluTurn[]; draft?: Record<string, unknown> },
    trace: { limited?: boolean; detail?: string; meta?: AssistantReading['meta'] },
  ): Promise<AssistantPlan> {
    const venue = await assertVenueAccess(this.prisma, user, venueId, {
      write: false,
    });
    const clean = text.trim();
    if (clean.length < 2 || clean.length > 400) {
      throw new BadRequestException('text must be 2-400 characters');
    }
    if (!this.nlu.enabled)
      return this.blank('unknown', bi('', ''), { available: false });

    // The venue's own switch and credit, checked for the owner and every staff login alike
    // (the permission guards let owners through, so this cannot be a permission).
    const credit = await this.credit?.check(venueId);
    if (credit && !credit.ok) {
      trace.limited = true;
      trace.detail = `credit_${credit.reason}`;
      this.logger.warn(`[assistant-credit] ${credit.reason} for venue ${venueId}`);
      return this.blank('unknown', await this.creditReply(user, venueId, credit));
    }

    // Burst protection only; cost is capped by the venue's credit. One window per venue.
    const verdict = await this.quota?.take('owner', [
      {
        key: `venue:${venueId}`,
        perMinute: this.settings?.number('ownerPerMinute') ?? 20,
        perDay: Number.MAX_SAFE_INTEGER,
      },
    ]);
    if (verdict && !verdict.ok) {
      trace.limited = true;
      this.logger.warn(`[assistant-limit] ${verdict.reason} for venue ${venueId}`);
      return this.blank(
        'unknown',
        bi(
          `بالراحة شوية، استنى ${Math.min(verdict.retryAfterSec, 60)} ثانية وابعت تاني.`,
          `Easy: wait ${Math.min(verdict.retryAfterSec, 60)} seconds and send again.`,
        ),
      );
    }

    const tz = await this.venueTz(venueId);
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(
      new Date(),
    );
    const [courtRows, openBalances] = await Promise.all([
      this.prisma.court.findMany({
        where: { venueId },
        select: {
          id: true,
          name: true,
          format: true,
          gamingConfig: true,
          tableConfig: true,
          sport: { select: { nameEn: true, nameAr: true } },
        },
        orderBy: { name: 'asc' },
      }),
      this.openBalanceBookings(venueId),
    ]);
    const courts: NluCourtRef[] = courtRows.map((c) => ({
      id: c.id,
      name: c.name,
      details: courtDetails(c),
      sportAr: c.sport?.nameAr,
    }));

    const known: NluKnownBooking[] = openBalances.map((b) => ({
      name: b.customerName ?? '',
      courtName: b.courtName,
      time: zonedHhmm(new Date(b.startsAt), tz),
      outstanding: Math.round(b.outstanding / 100),
    }));

    const draft = sanitizeDraft(extra.draft, courts);
    let costUsd = 0;
    const raw = await this.nlu.read(clean, courts, today, known, {
      venueName: venue.nameAr || venue.nameEn,
      nowHhmm: zonedHhmm(new Date(), tz),
      history: extra.history,
      draft,
      onCost: (usd) => {
        costUsd += usd;
      },
    });
    // The venue pays for its owner's and staff's calls; a platform admin looking in does not.
    const platformAdmin = user.roles.includes('admin') && venue.ownerId !== user.id;
    if (credit?.ok && costUsd > 0 && !platformAdmin) await this.credit?.charge(venueId, credit.view, costUsd);
    if (!raw) return this.blank('unknown', bi('', ''), { available: false });
    trace.meta = raw.meta;
    const reading = completeReading(raw, draft, clean, courts);

    const bar = WRITES_MONEY.has(reading.intent)
      ? MIN_CONFIDENCE_WRITE
      : MIN_CONFIDENCE;
    if (reading.confidence < bar || reading.intent === 'unknown') {
      return this.blank('unknown', this.clarify(reading), {
        confidence: reading.confidence,
        draft,
      });
    }
    if (reading.intent === 'help') return this.blank('help', await this.helpText(venueId));

    const currency = venue.currency;
    try {
      switch (reading.intent) {
        case 'book':
          return await this.planBook(user, venueId, tz, currency, reading);
        case 'pay':
          return await this.planPay(user, venueId, tz, currency, reading);
        case 'cancel':
          return await this.planCancel(user, venueId, tz, currency, reading, clean);
        case 'move':
          return await this.planMove(user, venueId, tz, currency, reading, courts);
        case 'agenda':
          return await this.planAgenda(user, venueId, tz, currency, reading);
        case 'attention':
          return await this.attention(user, venueId, tz, currency);
        case 'money':
          return await this.planMoney(user, venueId, currency, reading);
        case 'debts':
          return await this.planDebts(user, venueId, tz, currency, reading);
        case 'expense':
          return await this.planExpense(user, venueId, currency, reading);
        case 'block':
        case 'unblock':
          return await this.planSchedule(user, venueId, reading, courts);
        case 'free':
          return this.planFree(reading);
        default:
          return this.blank('unknown', this.clarify(reading), {
            confidence: reading.confidence,
          });
      }
    } catch (err) {
      // A planning failure must never look like a completed action.
      this.logger.warn(`assistant planning failed (${reading.intent}): ${err}`);
      return this.blank(
        reading.intent,
        bi(
          'حصلت مشكلة وأنا بجهّز الطلب ده. جرّب تاني.',
          'Something went wrong preparing that. Try again.',
        ),
      );
    }
  }

  private async planBook(
    user: AuthenticatedUser,
    venueId: string,
    tz: string,
    currency: string,
    r: AssistantReading,
  ): Promise<AssistantPlan> {
    if (!(await this.can(user, venueId, 'bookings.create'))) {
      return this.denied('book');
    }
    const courts = await this.prisma.court.findMany({
      where: { venueId },
      include: { pricingRules: true, sport: { select: { nameAr: true } } },
      orderBy: { name: 'asc' },
    });
    if (!courts.length) {
      return this.blank(
        'book',
        bi('المنشأة دي لسه مفيهاش وحدات تتحجز. ضيف الأول من «المنشآت».', 'This venue has nothing to book yet. Add a unit under “Venues” first.'),
      );
    }
    const words = await this.unitWordsFor(venueId);
    const court = r.courtIds.length
      ? courts.find((c) => c.id === r.courtIds[0])
      : courts.length === 1
        ? courts[0]
        : undefined;
    if (!court) {
      return this.blank(
        'book',
        bi(
          `${words.ar.which} بالظبط؟ عندك: ${listUnits(courts.map((c) => ({ name: c.name, sportAr: c.sport?.nameAr })))}.`,
          `Which ${words.en.one} exactly? You have: ${listUnits(courts.map((c) => ({ name: c.name, sportAr: c.sport?.nameAr })), ', ')}.`,
        ),
        { confidence: r.confidence, draft: r },
      );
    }
    if (r.fromMins === null) {
      return this.blank(
        'book',
        bi(
          `تمام، ${court.name} يوم ${r.date}. الساعة كام والمدة قد إيه؟`,
          `Got it — ${court.name} on ${r.date}. What time, and for how long?`,
        ),
        { confidence: r.confidence, draft: { ...r, courtIds: [court.id] } },
      );
    }

    // Duration: what the owner said, else the stated window, else one slot.
    const spanned = r.toMins !== null ? r.toMins - r.fromMins : null;
    const rawDuration =
      r.durationMinutes ?? spanned ?? court.slotDurationMins ?? 60;
    const durationMinutes = Math.max(15, Math.round(rawDuration / 15) * 15);
    const startsAt = zonedWallTimeToUtc(r.date, hhmm(r.fromMins), tz);
    const endsAt = new Date(startsAt.getTime() + durationMinutes * 60_000);

    const issues: AssistantIssue[] = [];
    if (startsAt.getTime() < Date.now()) {
      if (r.date === todayIn(tz)) {
        const tomorrow = nextDay(r.date);
        return this.blank(
          'book',
          bi(
            `الساعة ${hhmm(r.fromMins)} النهاردة عدّت خلاص. تقصد بكرة (${tomorrow})؟`,
            `${hhmm(r.fromMins)} today has already passed. Did you mean tomorrow (${tomorrow})?`,
          ),
          {
            confidence: r.confidence,
            draft: { ...r, courtIds: [court.id], date: tomorrow },
          },
        );
      }
      issues.push({
        code: 'PAST_SLOT',
        blocking: true,
        message: bi(
          'الميعاد ده عدّى خلاص — مش هقدر أسجّل حجز في الماضي.',
          'That time has already passed — I cannot book into the past.',
        ),
      });
    }

    const conflict = await this.bookings.slotConflict(
      this.prisma,
      court.id,
      venueId,
      startsAt,
      endsAt,
    );
    let overrideBlocks = false;
    if (conflict === 'SLOT_BLOCKED') {
      const blocks = await this.prisma.calendarBlock.findMany({
        where: {
          venueId,
          OR: [{ courtId: court.id }, { courtId: null }],
          startsAt: { lt: endsAt },
          endsAt: { gt: startsAt },
        },
        select: { note: true, kind: true },
      });
      const why = [
        ...new Set(
          blocks.map((b) => b.note || (b.kind === 'maintenance' ? 'صيانة' : 'حجز خاص')),
        ),
      ].join('، ');
      if (await this.can(user, venueId, 'schedule.manage')) {
        overrideBlocks = true;
        issues.push({
          code: 'BLOCK_OVERRIDE',
          blocking: false,
          message: bi(
            `⚠️ الميعاد ده إنت قافله قبل كده (${why}). لو أكدت هفتح القفل وأسجل الحجز${r.customerName ? ' لـ ' + r.customerName : ''}.`,
            `⚠️ You closed this window earlier (${why}). If you confirm I will reopen it and record the booking${r.customerName ? ' for ' + r.customerName : ''}.`,
          ),
        });
      } else {
        issues.push({
          code: 'SLOT_TAKEN',
          blocking: true,
          message: bi(
            `الميعاد ده مقفول (${why}) ومعندكش صلاحية تفتحه — كلّم صاحب المكان.`,
            `That window is closed (${why}) and you cannot reopen it — ask the owner.`,
          ),
        });
      }
    } else if (conflict) {
      const alt = await this.alternatives(
        venueId,
        tz,
        court.id,
        courts,
        startsAt,
        durationMinutes,
      );
      issues.push({
        code: 'SLOT_TAKEN',
        blocking: true,
        message: bi(
          `الميعاد ده محجوز بالفعل على ${court.name}.${alt.ar ? ' ' + alt.ar : ''}`,
          `That window is already booked on ${court.name}.${alt.en ? ' ' + alt.en : ''}`,
        ),
      });
      return {
        ...this.blank('book', this.issueReply(issues, bi('', '')), {
          confidence: r.confidence,
          draft: { ...r, courtIds: [court.id] },
        }),
        issues,
      };
    }

    if (r.customerName) {
      const same = await this.sameDayBookings(venueId, tz, r.date, r.customerName);
      if (same.length) {
        issues.push({
          code: 'DUPLICATE_CUSTOMER',
          blocking: false,
          message: bi(
            `تنبيه: ${r.customerName} عنده حجز تاني اليوم ده (${same.join('، ')}). تأكد إنه مش تكرار.`,
            `Heads up: ${r.customerName} already has a booking that day (${same.join(', ')}). Make sure this is not a duplicate.`,
          ),
        });
      }
    }
    if (durationMinutes >= 300) {
      issues.push({
        code: 'LONG_BOOKING',
        blocking: false,
        message: bi(
          `تنبيه: الحجز ده ${durationMinutes / 60} ساعات — تأكد من المدة.`,
          `Heads up: that is a ${durationMinutes / 60}-hour booking — check the length.`,
        ),
      });
    }

    const tariff = quoteDurationPrice(
      court.pricingRules,
      startsAt,
      durationMinutes,
      tz,
    ).priceAmount;
    const saidNothingAboutMoney =
      r.totalAmount === null &&
      r.paidAmount === null &&
      r.remainingAmount === null;
    const money = this.reconcileBookingMoney(
      saidNothingAboutMoney ? { ...r, paidAmount: 0 } : r,
      tariff,
      currency,
      issues,
    );
    if (money === null) {
      return {
        ...this.blank(
          'book',
          this.issueReply(issues, bi('قولّي السعر.', 'Tell me the price.')),
          { draft: { ...r, courtIds: [court.id] } },
        ),
        issues,
      };
    }

    const window = `${hhmm(r.fromMins)}–${zonedHhmm(endsAt, tz)}`;
    const who = r.customerName || '';
    const priceText = fmt(money.total, currency);
    const paidText = fmt(money.paid, currency);
    const dueText = fmt(money.outstanding, currency);

    const summary = joinBi(
      [
        bi(
          `حجز ${who || 'عميل'} في ${court.name} يوم ${r.date} (${window})`,
          `Booking for ${who || 'a customer'} on ${court.name}, ${r.date} (${window})`,
        ),
        bi(`— السعر ${priceText.ar}`, `— price ${priceText.en}`),
        money.paid > 0
          ? bi(`، مدفوع ${paidText.ar}`, `, paid ${paidText.en}`)
          : bi('، لسه مدفعش حاجة', ', nothing paid yet'),
        money.outstanding > 0
          ? bi(`، باقي ${dueText.ar}.`, `, ${dueText.en} outstanding.`)
          : bi('، خالص.', ', settled.'),
      ],
      '',
    );

    const blocking = issues.some((i) => i.blocking);
    const finalSummary = overrideBlocks
      ? joinBi(
          [
            summary,
            bi(
              ' وهفتح القفل اللي على الميعاد ده.',
              ' I will also reopen the block on that window.',
            ),
          ],
          '',
        )
      : summary;
    const actions: AssistantAction[] = blocking
      ? []
      : [
          {
            kind: 'create_booking',
            courtId: court.id,
            startsAt: startsAt.toISOString(),
            durationMinutes,
            priceAmount: money.total,
            paymentStatus: money.status,
            paidAmount: money.status === 'partial' ? money.paid : undefined,
            paymentMethod: r.paymentMethod ?? 'cash',
            customerName: r.customerName || undefined,
            customerPhone: r.customerPhone || undefined,
            sourceKey: r.sourceKey ?? 'walk_in',
            notes: r.reason || undefined,
            overrideBlocks: overrideBlocks || undefined,
          },
        ];

    return {
      available: true,
      intent: 'book',
      confidence: r.confidence,
      reply: this.issueReply(issues, finalSummary),
      summary: blocking ? null : finalSummary,
      actions,
      schedule: null,
      query: null,
      issues,
      bookings: [],
      needsConfirm: actions.length > 0,
    };
  }

  private reconcileBookingMoney(
    r: AssistantReading,
    tariffMinor: number | null,
    currency: string,
    issues: AssistantIssue[],
  ) {
    const verdict = reconcileBookingMoney(
      {
        total: r.totalAmount === null ? null : toMinor(r.totalAmount),
        paid: r.paidAmount === null ? null : toMinor(r.paidAmount),
        remaining:
          r.remainingAmount === null ? null : toMinor(r.remainingAmount),
      },
      tariffMinor,
      currency,
    );
    issues.push(...verdict.issues);
    return verdict.money;
  }

  private async planPay(
    user: AuthenticatedUser,
    venueId: string,
    tz: string,
    currency: string,
    r: AssistantReading,
  ): Promise<AssistantPlan> {
    if (!(await this.can(user, venueId, 'payments.record')))
      return this.denied('pay');

    const candidates = await this.findBookings(venueId, tz, r, {
      onlyOwing: true,
    });
    if (!candidates.length && r.customerName) {
      // "محمد دفع" when محمد owes nothing is worth saying, not "not found".
      const any = await this.findBookings(venueId, tz, r, { onlyOwing: false });
      if (any.length) {
        return this.blank(
          'pay',
          bi(
            `${r.customerName} مفيش عليه حاجة — حجزه خالص ✅ (مسجّل دفع كامل).`,
            `${r.customerName} owes nothing — that booking is already settled ✅.`,
          ),
          { confidence: r.confidence, bookings: any.slice(0, 3) },
        );
      }
    }
    const picked = this.pickOne(candidates, r, currency, tz);
    if ('issue' in picked) return picked.plan;
    const booking = picked.booking;

    const statedRaw = r.paidAmount ?? r.totalAmount;
    const amount =
      statedRaw === null || statedRaw === undefined
        ? booking.outstanding
        : toMinor(statedRaw);
    const issues: AssistantIssue[] = [];
    if (amount <= 0) {
      return this.blank('pay', bi('المبلغ كام؟', 'How much did they pay?'));
    }
    if (amount > booking.outstanding) {
      issues.push({
        code: 'OVERPAYMENT',
        blocking: true,
        message: bi(
          `${booking.customerName ?? 'الحجز ده'} عليه ${fmt(booking.outstanding, currency).ar} بس، وانت قلت ${fmt(amount, currency).ar}. ` +
            `لو خدت زيادة ده مش هيتسجل كدفع للحجز — راجع المبلغ.`,
          `${booking.customerName ?? 'That booking'} only owes ${fmt(booking.outstanding, currency).en}, you said ${fmt(amount, currency).en}. ` +
            `I will not record more than the balance — check the amount.`,
        ),
      });
      return {
        ...this.blank('pay', this.issueReply(issues, bi('', ''))),
        issues,
        bookings: [booking],
      };
    }

    const left = booking.outstanding - amount;
    const summary = bi(
      `تسجيل دفع ${fmt(amount, currency).ar} من ${booking.customerName ?? 'الحجز ' + booking.code} ` +
        `(${booking.courtName} ${zonedHhmm(new Date(booking.startsAt), tz)}) — ` +
        (left > 0 ? `يفضل عليه ${fmt(left, currency).ar}.` : 'ويبقى خالص ✅'),
      `Record ${fmt(amount, currency).en} from ${booking.customerName ?? booking.code} ` +
        `(${booking.courtName} ${zonedHhmm(new Date(booking.startsAt), tz)}) — ` +
        (left > 0
          ? `${fmt(left, currency).en} would still be owed.`
          : 'that settles it ✅'),
    );

    return {
      available: true,
      intent: 'pay',
      confidence: r.confidence,
      reply: summary,
      summary,
      actions: [
        {
          kind: 'record_payment',
          bookingId: booking.id,
          amount,
          method: r.paymentMethod ?? 'cash',
        },
      ],
      schedule: null,
      query: null,
      issues,
      bookings: [booking],
      needsConfirm: true,
    };
  }

  private async planCancel(
    user: AuthenticatedUser,
    venueId: string,
    tz: string,
    currency: string,
    r: AssistantReading,
    text = '',
  ): Promise<AssistantPlan> {
    if (!(await this.can(user, venueId, 'bookings.edit')))
      return this.denied('cancel');
    const candidates = await this.findBookings(venueId, tz, r, {
      onlyOwing: false,
    });
    const picked = this.pickOne(candidates, r, currency, tz);
    if ('issue' in picked) return picked.plan;
    const booking = picked.booking;

    const paid = booking.paidAmount;
    let refundAmount: number | undefined;
    if (paid > 0) {
      const intent = refundIntent(text);
      if (intent === 'ask') {
        return this.blank(
          'cancel',
          bi(
            `الحجز ده اتدفع فيه ${fmt(paid, currency).ar}. أرجّع الفلوس للعميل ولا تحتفظ بيها؟ ` +
              'قول «الغي الحجز ورجّع الفلوس» أو «الغي الحجز واحتفظ بالعربون».',
            `${fmt(paid, currency).en} was already paid on this booking. Hand it back, or keep it? ` +
              'Say "cancel and refund" or "cancel and keep the deposit".',
          ),
          { bookings: [booking], confidence: r.confidence },
        );
      }
      refundAmount = intent === 'refund' ? paid : 0;
    }

    const when = zonedHhmm(new Date(booking.startsAt), tz);
    const who = booking.customerName ?? booking.code;
    const summary = bi(
      `إلغاء حجز ${who} في ${booking.courtName} ${when}` +
        (paid > 0
          ? refundAmount
            ? ` — هرجّع ${fmt(paid, currency).ar} للعميل.`
            : ` — هتحتفظ بـ ${fmt(paid, currency).ar} كعربون.`
          : '.'),
      `Cancel ${who} on ${booking.courtName} ${when}` +
        (paid > 0
          ? refundAmount
            ? ` — ${fmt(paid, currency).en} will be handed back.`
            : ` — you keep the ${fmt(paid, currency).en} deposit.`
          : '.'),
    );

    return {
      available: true,
      intent: 'cancel',
      confidence: r.confidence,
      reply: summary,
      summary,
      actions: [
        {
          kind: 'cancel_booking',
          bookingId: booking.id,
          reason: r.reason || undefined,
          refundAmount,
        },
      ],
      schedule: null,
      query: null,
      issues: [],
      bookings: [booking],
      needsConfirm: true,
    };
  }

  private async planMoney(
    user: AuthenticatedUser,
    venueId: string,
    currency: string,
    r: AssistantReading,
  ): Promise<AssistantPlan> {
    if (!(await this.can(user, venueId, 'reports.view')))
      return this.denied('money');
    const range = r.rangeKey ?? 'today';
    const s = await this.summary.getSummary(user, venueId, range);
    const t = s.totals;
    const label = this.rangeLabel(range);
    const lines: Bi[] = [
      bi(
        `${label.ar}: ${t.bookings} حجز، إيراد ألعابها ${fmt(t.collectedRevenue, currency).ar}.`,
        `${label.en}: ${t.bookings} bookings, ${fmt(t.collectedRevenue, currency).en} of game revenue.`,
      ),
    ];
    const cashbook = s.cashbook;
    if (cashbook && cashbook.received !== t.collectedRevenue) {
      const extra: Bi[] = [];
      if (cashbook.advance > 0)
        extra.push(bi(`${fmt(cashbook.advance, currency).ar} عربون لحجوزات جاية`, `${fmt(cashbook.advance, currency).en} deposits for later games`));
      if (cashbook.late > 0)
        extra.push(bi(`${fmt(cashbook.late, currency).ar} لحجوزات فاتت`, `${fmt(cashbook.late, currency).en} for earlier games`));
      lines.push(
        bi(
          `اتقبض فعليًا ${fmt(cashbook.received, currency).ar}${extra.length ? ` (منها ${extra.map((e) => e.ar).join(' و')})` : ''}.`,
          `Actually received: ${fmt(cashbook.received, currency).en}${extra.length ? ` (including ${extra.map((e) => e.en).join(' and ')})` : ''}.`,
        ),
      );
    }
    if (t.outstanding > 0) {
      lines.push(
        bi(
          `لسه ليك ${fmt(t.outstanding, currency).ar} عند العملاء.`,
          `${fmt(t.outstanding, currency).en} is still owed to you.`,
        ),
      );
    }
    if (t.expenses > 0) {
      lines.push(
        bi(
          `مصاريف ${fmt(t.expenses, currency).ar}.`,
          `${fmt(t.expenses, currency).en} in expenses.`,
        ),
      );
    }
    lines.push(
      bi(
        `صافي ربحك: ${fmt(t.netProfit, currency).ar}.`,
        `Your net profit: ${fmt(t.netProfit, currency).en}.`,
      ),
    );
    return this.blank('money', joinBi(lines, '\n'), {
      confidence: r.confidence,
    });
  }

  private async planDebts(
    user: AuthenticatedUser,
    venueId: string,
    tz: string,
    currency: string,
    r: AssistantReading,
  ): Promise<AssistantPlan> {
    if (!(await this.can(user, venueId, 'bookings.view')))
      return this.denied('debts');
    if (!(await this.can(user, venueId, 'payments.record')) && !(await this.can(user, venueId, 'reports.view')))
      return this.denied('debts');
    const { overdue, upcoming } = await findAllOwed(this.prisma, venueId);
    if (!overdue.length && !upcoming.length) {
      return this.blank(
        'debts',
        bi(
          'محدش عليه فلوس — كله خالص ✅ (راجعت الحجوزات اللي خلصت واللي جاية).',
          'Nobody owes you anything — all settled ✅ (finished and upcoming bookings checked).',
        ),
        { confidence: r.confidence },
      );
    }
    const day = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d);
    const line = (b: OwedRow) =>
      bi(
        `• ${b.customerName ?? b.code} — ${fmt(b.outstanding, currency).ar} (${b.courtName}، ${day(b.slotStart)} ${zonedHhmm(b.slotStart, tz)})`,
        `• ${b.customerName ?? b.code} — ${fmt(b.outstanding, currency).en} (${b.courtName}, ${day(b.slotStart)} ${zonedHhmm(b.slotStart, tz)})`,
      );
    const sum = (rows: OwedRow[]) => rows.reduce((s, b) => s + b.outstanding, 0);
    const lines: Bi[] = [];
    if (overdue.length) {
      lines.push(
        bi(
          `💰 ${overdue.length} حجز خلص وعليهم ${fmt(sum(overdue), currency).ar}:`,
          `💰 ${overdue.length} finished bookings owe ${fmt(sum(overdue), currency).en}:`,
        ),
        ...overdue.slice(0, 8).map(line),
      );
    }
    if (upcoming.length) {
      lines.push(
        bi(
          `⏰ ${upcoming.length} حجز جاي وعليهم ${fmt(sum(upcoming), currency).ar}:`,
          `⏰ ${upcoming.length} upcoming bookings carry ${fmt(sum(upcoming), currency).en}:`,
        ),
        ...upcoming.slice(0, 8).map(line),
      );
    }
    const refs = [...overdue, ...upcoming].slice(0, 10).map((b) => ({
      id: b.id,
      code: b.code,
      customerName: b.customerName,
      courtName: b.courtName,
      startsAt: b.slotStart.toISOString(),
      endsAt: b.slotEnd.toISOString(),
      totalAmount: b.totalAmount,
      paidAmount: b.paidAmount,
      outstanding: b.outstanding,
      currency: b.currency,
    }));
    return {
      ...this.blank('debts', joinBi(lines, '\n'), { confidence: r.confidence }),
      bookings: refs,
    };
  }

  private async planExpense(
    user: AuthenticatedUser,
    venueId: string,
    currency: string,
    r: AssistantReading,
  ): Promise<AssistantPlan> {
    if (!(await this.can(user, venueId, 'expenses.manage')))
      return this.denied('expense');
    const amountMajor = r.totalAmount ?? r.paidAmount;
    if (!amountMajor) {
      return this.blank(
        'expense',
        bi('المصروف ده بكام؟', 'How much was that expense?'),
      );
    }
    const amount = toMinor(amountMajor);
    const category = r.expenseCategory ?? 'other';
    const label = this.expenseLabel(category, r.reason);
    const summary = bi(
      `تسجيل مصروف ${fmt(amount, currency).ar} — ${label.ar} يوم ${r.date}.`,
      `Record a ${fmt(amount, currency).en} expense — ${label.en} on ${r.date}.`,
    );
    return {
      available: true,
      intent: 'expense',
      confidence: r.confidence,
      reply: summary,
      summary,
      actions: [
        {
          kind: 'add_expense',
          venueId,
          category,
          amount,
          incurredOn: r.date,
          note: r.reason || undefined,
        },
      ],
      schedule: null,
      query: null,
      issues: [],
      bookings: [],
      needsConfirm: true,
    };
  }

  private async planSchedule(
    user: AuthenticatedUser,
    venueId: string,
    r: AssistantReading,
    courts: NluCourtRef[],
  ): Promise<AssistantPlan> {
    if (!(await this.can(user, venueId, 'schedule.manage')))
      return this.denied(r.intent);
    let courtIds = r.courtIds;
    if (!courtIds.length && !r.allCourts && courts.length === 1)
      courtIds = [courts[0].id];
    if (!courtIds.length && !r.allCourts) {
      const words = await this.unitWordsFor(venueId);
      return this.blank(
        r.intent,
        bi(
          `${words.ar.which} بالظبط؟ عندك: ${listUnits(courts)} — أو قول «كله».`,
          `Which ${words.en.one}? You have: ${listUnits(courts, ', ')} — or say "all".`,
        ),
        { confidence: r.confidence, draft: r },
      );
    }
    if (r.intent === 'block' && r.fromMins === null) {
      return this.blank(
        'block',
        bi(
          'من الساعة كام لكام؟ مش هقفل اليوم كله من غير ما تحدد.',
          'From what time to what time? I will not close a whole day blindly.',
        ),
        { confidence: r.confidence, draft: { ...r, courtIds } },
      );
    }
    if (r.intent === 'block' && r.fromMins !== null) {
      const tz = await this.venueTz(venueId);
      const start = zonedWallTimeToUtc(r.date, hhmm(r.fromMins), tz);
      const end =
        r.toMins !== null
          ? zonedWallTimeToUtc(r.date, hhmm(r.toMins), tz)
          : zonedDayBounds(r.date, tz).end;
      const clash = await this.prisma.booking.findMany({
        where: {
          venueId,
          status: { in: ['held', 'confirmed'] },
          ...(courtIds.length ? { courtId: { in: courtIds } } : {}),
          slotStart: { lt: end },
          slotEnd: { gt: start },
        },
        include: { court: { select: { name: true } } },
        orderBy: { slotStart: 'asc' },
        take: 6,
      });
      if (clash.length) {
        const list = clash
          .map(
            (b) =>
              `• ${b.guestName ?? b.code} — ${b.court.name} ${zonedHhmm(b.slotStart, tz)}`,
          )
          .join('\n');
        const issue: AssistantIssue = {
          code: 'HAS_BOOKINGS',
          blocking: true,
          message: bi(
            `مش هقفل الميعاد ده — فيه حجوزات فيه:\n${list}\nلو عايز أقفله لازم نلغي أو ننقل الحجوزات دي الأول.`,
            `I will not close that window — it has bookings:\n${list}\nCancel or move them first.`,
          ),
        };
        return {
          ...this.blank('block', issue.message, { confidence: r.confidence }),
          issues: [issue],
          bookings: clash.slice(0, 6).map((b) => this.toRef({ ...b, payments: [] })),
        };
      }
    }
    return {
      available: true,
      intent: r.intent,
      confidence: r.confidence,
      reply: bi('', ''),
      summary: null,
      actions: [],
      schedule: {
        mode: r.intent === 'block' ? 'block' : 'unblock',
        courtIds,
        allCourts: r.allCourts,
        date: r.date,
        fromMins: r.fromMins,
        toMins: r.toMins,
        reason: r.reason,
      },
      query: null,
      issues: [],
      bookings: [],
      needsConfirm: false,
    };
  }

  private async planAgenda(
    user: AuthenticatedUser,
    venueId: string,
    tz: string,
    currency: string,
    r: AssistantReading,
  ): Promise<AssistantPlan> {
    if (!(await this.can(user, venueId, 'bookings.view')))
      return this.denied('agenda');
    const { start, end } = zonedDayBounds(r.date, tz);
    const rows = await this.prisma.booking.findMany({
      where: {
        venueId,
        status: { in: ['held', 'confirmed'] },
        slotStart: { gte: start, lt: end },
        ...(r.courtIds.length ? { courtId: { in: r.courtIds } } : {}),
      },
      include: {
        court: { select: { name: true } },
        // Net of refunds: money handed back is not money still held.
        payments: { where: { status: { in: ['paid', 'refunded'] } }, select: { amount: true } },
      },
      orderBy: { slotStart: 'asc' },
      take: 40,
    });
    if (!rows.length) {
      return this.blank(
        'agenda',
        bi(`مفيش حجوزات يوم ${r.date}.`, `No bookings on ${r.date}.`),
        { confidence: r.confidence },
      );
    }
    const refs = rows.map((b) => this.toRef(b));
    const lines = refs.map((b) => {
      const window = `${zonedHhmm(new Date(b.startsAt), tz)}–${zonedHhmm(new Date(b.endsAt), tz)}`;
      const owes =
        b.outstanding > 0
          ? bi(
              ` (باقي ${fmt(b.outstanding, currency).ar})`,
              ` (${fmt(b.outstanding, currency).en} due)`,
            )
          : bi('', '');
      return bi(
        `• ${window} ${b.courtName} — ${b.customerName ?? b.code}${owes.ar}`,
        `• ${window} ${b.courtName} — ${b.customerName ?? b.code}${owes.en}`,
      );
    });
    const head = bi(
      `${refs.length} حجز يوم ${r.date}:`,
      `${refs.length} bookings on ${r.date}:`,
    );
    return {
      ...this.blank('agenda', joinBi([head, ...lines], '\n'), {
        confidence: r.confidence,
      }),
      bookings: refs.slice(0, 10),
    };
  }

  private async planMove(
    user: AuthenticatedUser,
    venueId: string,
    tz: string,
    currency: string,
    r: AssistantReading,
    courts: NluCourtRef[],
  ): Promise<AssistantPlan> {
    if (!(await this.can(user, venueId, 'bookings.edit')))
      return this.denied('move');
    const candidates = await this.findBookings(
      venueId,
      tz,
      { ...r, courtIds: [], fromMins: r.newFromMins === null ? null : r.fromMins },
      { onlyOwing: false },
    );
    const picked = this.pickOne(candidates, r, currency, tz);
    if ('issue' in picked) return picked.plan;
    const booking = picked.booking;
    const who = booking.customerName ?? booking.code;

    const oldStart = new Date(booking.startsAt);
    const oldDuration = Math.round(
      (new Date(booking.endsAt).getTime() - oldStart.getTime()) / 60_000,
    );
    const nothingToChange =
      r.newDate === null &&
      r.newFromMins === null &&
      r.newCourtId === null &&
      r.durationMinutes === null &&
      r.totalAmount === null;
    if (nothingToChange) {
      const words = await this.unitWordsFor(venueId);
      return this.blank(
        'move',
        bi(
          `تمام، حجز ${who}. تعدّل فيه إيه — الوقت، ${words.ar.one === 'وحدة' ? 'المكان' : 'ال' + words.ar.one}، المدة ولا السعر؟`,
          `OK, ${who}'s booking. What should change — time, ${words.en.one}, length or price?`,
        ),
        { confidence: r.confidence, draft: r, bookings: [booking] },
      );
    }

    const oldDate = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(
      oldStart,
    );
    const newDate = r.newDate ?? oldDate;
    const newTime =
      r.newFromMins !== null ? hhmm(r.newFromMins) : zonedHhmm(oldStart, tz);
    const newStart = zonedWallTimeToUtc(newDate, newTime, tz);
    const duration = Math.max(
      15,
      Math.round((r.durationMinutes ?? oldDuration) / 15) * 15,
    );
    const newEnd = new Date(newStart.getTime() + duration * 60_000);
    const oldCourt = courts.find((c) => c.name === booking.courtName);
    const courtId = r.newCourtId ?? undefined;
    const targetCourtId = courtId ?? oldCourt?.id;
    const targetCourtName =
      courts.find((c) => c.id === targetCourtId)?.name ?? booking.courtName;

    const movedPlace =
      newStart.getTime() !== oldStart.getTime() ||
      (courtId !== undefined && courtId !== oldCourt?.id);
    const issues: AssistantIssue[] = [];
    if (movedPlace && newStart.getTime() < Date.now()) {
      issues.push({
        code: 'PAST_SLOT',
        blocking: true,
        message: bi(
          'الميعاد الجديد عدّى خلاص — مش هقدر أنقل حجز للماضي.',
          'The new time has already passed — I cannot move a booking into the past.',
        ),
      });
    }
    if (targetCourtId && (movedPlace || duration !== oldDuration)) {
      const conflict = await this.bookings.slotConflict(
        this.prisma,
        targetCourtId,
        venueId,
        newStart,
        newEnd,
        booking.id,
      );
      if (conflict) {
        issues.push({
          code: 'SLOT_TAKEN',
          blocking: true,
          message:
            conflict === 'SLOT_BLOCKED'
              ? bi(
                  'الميعاد الجديد مقفول عندك — افتحه الأول.',
                  'The new window is closed — reopen it first.',
                )
              : bi(
                  'الميعاد الجديد محجوز بالفعل.',
                  'The new window is already booked.',
                ),
        });
      }
    }
    if (issues.some((i) => i.blocking)) {
      return {
        ...this.blank('move', this.issueReply(issues, bi('', '')), {
          confidence: r.confidence,
        }),
        issues,
        bookings: [booking],
      };
    }

    const newPrice = r.totalAmount === null ? undefined : toMinor(r.totalAmount);
    const parts: Bi[] = [];
    if (movedPlace) {
      parts.push(
        bi(
          `${targetCourtName} يوم ${newDate} (${newTime}–${zonedHhmm(newEnd, tz)})`,
          `${targetCourtName} on ${newDate} (${newTime}–${zonedHhmm(newEnd, tz)})`,
        ),
      );
    } else if (duration !== oldDuration) {
      parts.push(
        bi(
          `المدة ${duration} دقيقة (${zonedHhmm(oldStart, tz)}–${zonedHhmm(newEnd, tz)})`,
          `${duration} minutes (${zonedHhmm(oldStart, tz)}–${zonedHhmm(newEnd, tz)})`,
        ),
      );
    }
    if (newPrice !== undefined)
      parts.push(
        bi(
          `السعر ${fmt(newPrice, currency).ar}`,
          `price ${fmt(newPrice, currency).en}`,
        ),
      );
    const summary = bi(
      `تعديل حجز ${who}: ${parts.map((p) => p.ar).join('، ')}.`,
      `Update ${who}: ${parts.map((p) => p.en).join(', ')}.`,
    );

    return {
      available: true,
      intent: 'move',
      confidence: r.confidence,
      reply: summary,
      summary,
      actions: [
        {
          kind: 'update_booking',
          bookingId: booking.id,
          courtId: courtId !== oldCourt?.id ? courtId : undefined,
          startsAt: movedPlace ? newStart.toISOString() : undefined,
          durationMinutes: duration !== oldDuration ? duration : undefined,
          priceAmount: newPrice,
        },
      ],
      schedule: null,
      query: null,
      issues,
      bookings: [booking],
      needsConfirm: true,
    };
  }

  private planFree(r: AssistantReading): AssistantPlan {
    return {
      ...this.blank('free', bi('', ''), { confidence: r.confidence }),
      query: {
        date: r.date,
        courtIds: r.courtIds,
        allCourts: r.allCourts,
        fromMins: r.fromMins,
        toMins: r.toMins,
      },
    };
  }

  async attention(
    user: AuthenticatedUser,
    venueId: string,
    tz: string,
    currency: string,
  ): Promise<AssistantPlan> {
    if (!(await this.can(user, venueId, 'bookings.view')))
      return this.denied('attention');
    const canSeeMoney = (await this.can(user, venueId, 'payments.record')) || (await this.can(user, venueId, 'reports.view'));
    const now = new Date();
    const [overdue, soon] = await Promise.all([
      canSeeMoney ? findOwed(this.prisma, { venueId }, { kind: 'overdue', now }) : Promise.resolve([]),
      canSeeMoney ? findOwed(
        this.prisma,
        { venueId },
        { kind: 'upcoming', from: now, to: new Date(now.getTime() + 3 * 3_600_000) },
      ) : Promise.resolve([]),
    ]);
    const tomorrow = zonedDayBounds(nextDay(todayIn(tz)), tz);
    const tomorrowCount = await this.prisma.booking.count({
      where: {
        venueId,
        status: { in: ['held', 'confirmed'] },
        slotStart: { gte: tomorrow.start, lt: tomorrow.end },
      },
    });
    const lines: Bi[] = [];
    if (soon.length) {
      lines.push(bi('⏰ جايين قريب وعليهم فلوس:', '⏰ Arriving soon with a balance:'));
      for (const b of soon.slice(0, 5)) {
        lines.push(
          bi(
            `• ${b.customerName ?? b.code} ${zonedHhmm(b.slotStart, tz)} (${b.courtName}) — باقي ${fmt(b.outstanding, currency).ar}`,
            `• ${b.customerName ?? b.code} ${zonedHhmm(b.slotStart, tz)} (${b.courtName}) — ${fmt(b.outstanding, currency).en} due`,
          ),
        );
      }
    }
    if (overdue.length) {
      const total = overdue.reduce((sum, b) => sum + b.outstanding, 0);
      lines.push(
        bi(
          `💰 ${overdue.length} حجز خلص وعليهم ${fmt(total, currency).ar} لسه:`,
          `💰 ${overdue.length} finished bookings still owe ${fmt(total, currency).en}:`,
        ),
      );
      for (const b of overdue.slice(-6).reverse()) {
        lines.push(
          bi(
            `• ${b.customerName ?? b.code} — ${fmt(b.outstanding, currency).ar} (${b.courtName}، ${new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(b.slotStart)})`,
            `• ${b.customerName ?? b.code} — ${fmt(b.outstanding, currency).en} (${b.courtName}, ${new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(b.slotStart)})`,
          ),
        );
      }
      lines.push(
        bi(
          'قولّي «فلان دفع» وأسجّلها، أو «مين عليه فلوس؟» للتفاصيل.',
          'Say "<name> paid" and I will record it.',
        ),
      );
    }
    if (tomorrowCount) {
      lines.push(
        bi(`📅 بكرة عندك ${tomorrowCount} حجز.`, `📅 Tomorrow: ${tomorrowCount} bookings.`),
      );
    }
    if (!soon.length && !overdue.length) {
      lines.unshift(
        canSeeMoney ? bi('كله تمام ✅ مفيش فلوس متأخرة ولا حاجة محتاجة انتباه.', 'All clear ✅ nothing overdue.') : bi('تابع حجوزات منشأتك من الجدول.', 'Follow your venue bookings on the schedule.'),
      );
    }
    return {
      ...this.blank('attention', joinBi(lines, '\n'), { confidence: 1 }),
      bookings: [...soon, ...overdue].slice(0, 10).map((b) => ({
        id: b.id,
        code: b.code,
        customerName: b.customerName,
        courtName: b.courtName,
        startsAt: b.slotStart.toISOString(),
        endsAt: b.slotEnd.toISOString(),
        totalAmount: 0,
        paidAmount: 0,
        outstanding: b.outstanding,
        currency: b.currency,
      })),
    };
  }

  async attentionDigest(user: AuthenticatedUser, venueId: string) {
    const venue = await assertVenueAccess(this.prisma, user, venueId, {
      write: false,
    });
    const tz = await this.venueTz(venueId);
    return this.attention(user, venueId, tz, venue.currency);
  }

  private async alternatives(
    venueId: string,
    tz: string,
    courtId: string,
    courts: { id: string; name: string }[],
    startsAt: Date,
    durationMinutes: number,
  ): Promise<Bi> {
    const endsAt = new Date(startsAt.getTime() + durationMinutes * 60_000);
    const others: string[] = [];
    for (const c of courts.filter((c) => c.id !== courtId)) {
      if (!(await this.bookings.slotConflict(this.prisma, c.id, venueId, startsAt, endsAt)))
        others.push(c.name);
    }
    const times: string[] = [];
    for (const k of [1, -1, 2, -2, 3, -3, 4, -4, 6, -6]) {
      if (times.length >= 3) break;
      const s = new Date(startsAt.getTime() + k * 30 * 60_000);
      if (s.getTime() < Date.now()) continue;
      const e = new Date(s.getTime() + durationMinutes * 60_000);
      if (!(await this.bookings.slotConflict(this.prisma, courtId, venueId, s, e)))
        times.push(zonedHhmm(s, tz));
    }
    const ar: string[] = [];
    const en: string[] = [];
    if (others.length) {
      ar.push(`فاضي في نفس الوقت: ${others.slice(0, 4).join('، ')}`);
      en.push(`Free at the same time: ${others.slice(0, 4).join(', ')}`);
    }
    if (times.length) {
      ar.push(`أو على نفس المكان الساعة ${times.join(' / ')}`);
      en.push(`or on the same court at ${times.join(' / ')}`);
    }
    if (!ar.length) return bi('', '');
    return bi(`${ar.join(' ')}. تحب أنهي؟`, `${en.join(' ')}. Which would you like?`);
  }

  private async sameDayBookings(
    venueId: string,
    tz: string,
    date: string,
    name: string,
  ): Promise<string[]> {
    const { start, end } = zonedDayBounds(date, tz);
    const rows = await this.prisma.booking.findMany({
      where: {
        venueId,
        status: { in: ['held', 'confirmed'] },
        slotStart: { gte: start, lt: end },
        guestName: { not: null },
      },
      include: { court: { select: { name: true } } },
      take: 50,
    });
    return this.matchName(rows, name).map(
      (b) => `${b.court.name} ${zonedHhmm(b.slotStart, tz)}`,
    );
  }

  private async openBalanceBookings(venueId: string): Promise<AssistantBookingRef[]> {
    const { overdue, upcoming } = await findAllOwed(this.prisma, venueId);
    return [...overdue, ...upcoming].map((b) => ({
      id: b.id,
      code: b.code,
      customerName: b.customerName,
      courtName: b.courtName,
      startsAt: b.slotStart.toISOString(),
      endsAt: b.slotEnd.toISOString(),
      totalAmount: b.totalAmount,
      paidAmount: b.paidAmount,
      outstanding: b.outstanding,
      currency: b.currency,
    }));
  }

  private toRef(b: {
    id: string;
    code: string;
    guestName: string | null;
    court: { name: string };
    slotStart: Date;
    slotEnd: Date;
    totalAmount: number;
    currency: string;
    payments: { amount: number }[];
  }): AssistantBookingRef {
    const paid = b.payments.reduce((sum, p) => sum + p.amount, 0);
    return {
      id: b.id,
      code: b.code,
      customerName: b.guestName,
      courtName: b.court.name,
      startsAt: b.slotStart.toISOString(),
      endsAt: b.slotEnd.toISOString(),
      totalAmount: b.totalAmount,
      paidAmount: paid,
      outstanding: Math.max(0, b.totalAmount - paid),
      currency: b.currency,
    };
  }

  private async findBookings(
    venueId: string,
    tz: string,
    r: AssistantReading,
    opts: { onlyOwing: boolean },
  ): Promise<AssistantBookingRef[]> {
    const { start, end } = zonedDayBounds(r.date, tz);
    const base: Prisma.BookingWhereInput = {
      venueId,
      source: 'manual',
      status: { not: 'cancelled' },
      ...(opts.onlyOwing
        ? { paymentStatus: { in: ['pending' as const, 'partial' as const] } }
        : {}),
      ...(r.courtIds.length ? { courtId: { in: r.courtIds } } : {}),
    };
    const include = {
      court: { select: { name: true } },
      payments: {
        where: { status: { in: ['paid' as const, 'refunded' as const] } },
        select: { amount: true },
      },
    };

    const sameDay = await this.prisma.booking.findMany({
      where: { ...base, slotStart: { gte: start, lt: end } },
      include,
      orderBy: { slotStart: 'asc' },
      take: 50,
    });
    let rows = sameDay;
    if (!this.matchName(sameDay, r.customerName).length && r.customerName) {
      const wider = await this.prisma.booking.findMany({
        where: {
          ...base,
          slotStart: {
            gte: start,
            lt: new Date(start.getTime() + 7 * 86_400_000),
          },
        },
        include,
        orderBy: { slotStart: 'asc' },
        take: 50,
      });
      rows = wider;
    }

    const named = this.matchName(rows, r.customerName);
    const byName = r.customerName ? named : rows;
    if (r.fromMins === null) return byName.map((b) => this.toRef(b));
    const at = byName.filter(
      (b) => zonedHhmm(b.slotStart, tz) === hhmm(r.fromMins!),
    );
    return (at.length ? at : byName).map((b) => this.toRef(b));
  }

  private matchName<T extends { guestName: string | null }>(
    rows: T[],
    name: string,
  ): T[] {
    if (!name) return [];
    const wanted = normalizeName(name);
    if (!wanted) return [];
    return rows.filter((b) => {
      const got = normalizeName(b.guestName ?? '');
      return got && (got.includes(wanted) || wanted.includes(got));
    });
  }

  private pickOne(
    candidates: AssistantBookingRef[],
    r: AssistantReading,
    currency: string,
    tz: string,
  ): { booking: AssistantBookingRef } | { issue: true; plan: AssistantPlan } {
    if (candidates.length === 1) return { booking: candidates[0] };
    if (!candidates.length) {
      const issue: AssistantIssue = {
        code: 'NOT_FOUND',
        blocking: true,
        message: r.customerName
          ? bi(
              `ملقتش حجز باسم «${r.customerName}» في اليوم ده.`,
              `I could not find a booking for "${r.customerName}" on that day.`,
            )
          : bi(
              'مين بالظبط؟ قولّي اسم العميل أو الميعاد.',
              'Which booking? Give me a name or a time.',
            ),
      };
      return {
        issue: true,
        plan: { ...this.blank(r.intent, issue.message), issues: [issue] },
      };
    }
    const list = candidates
      .slice(0, 6)
      .map(
        (b) =>
          `• ${b.customerName ?? b.code} — ${b.courtName} ${zonedHhmm(new Date(b.startsAt), tz)} (${fmt(b.outstanding, currency).ar})`,
      )
      .join('\n');
    const listEn = candidates
      .slice(0, 6)
      .map(
        (b) =>
          `• ${b.customerName ?? b.code} — ${b.courtName} ${zonedHhmm(new Date(b.startsAt), tz)} (${fmt(b.outstanding, currency).en})`,
      )
      .join('\n');
    const issue: AssistantIssue = {
      code: 'AMBIGUOUS_BOOKING',
      blocking: true,
      message: bi(
        `فيه أكتر من حجز يطابق كلامك:\n${list}\nقولّي أنهي واحد.`,
        `More than one booking matches:\n${listEn}\nWhich one?`,
      ),
    };
    return {
      issue: true,
      plan: {
        ...this.blank(r.intent, issue.message),
        issues: [issue],
        bookings: candidates.slice(0, 6),
      },
    };
  }

  private async can(
    user: AuthenticatedUser,
    venueId: string,
    permission: PermissionKey,
  ): Promise<boolean> {
    if (user.roles.includes('owner') || user.roles.includes('admin'))
      return true;
    const scope = await loadStaffScope(this.prisma, user.id);
    return scopeCan(scope, permission) && !!scope?.venueIds.includes(venueId);
  }

  private denied(intent: AssistantPlan['intent']): AssistantPlan {
    const issue: AssistantIssue = {
      code: 'NO_PERMISSION',
      blocking: true,
      message: bi(
        'الصلاحية دي مش معاك — كلّم صاحب المكان.',
        'You do not have permission for that — ask the owner.',
      ),
    };
    return { ...this.blank(intent, issue.message), issues: [issue] };
  }

  /** Why the assistant is off for this venue, and who can fix it: support for the owner, the owner for staff. */
  private async creditReply(
    user: AuthenticatedUser,
    venueId: string,
    credit: Extract<CreditVerdict, { ok: false }>,
  ): Promise<Bi> {
    const owner = user.roles.includes('owner') || user.roles.includes('admin');
    const rest = bi(
      'كل حاجة تانية شغالة عادي من لوحة المواعيد والأزرار.',
      'Everything else works as usual from the day board and its buttons.',
    );
    if (credit.reason === 'disabled') {
      return joinBi([
        bi('المساعد متوقف للمنشأة دي.', 'The assistant is switched off for this venue.'),
        rest,
        owner
          ? bi('علشان ترجّعه كلّم دعم ماتشنا.', 'To turn it back on, contact Matchena support.')
          : bi('علشان يرجع كلّم صاحب المنشأة.', 'To turn it back on, ask the venue owner.'),
      ]);
    }
    const v = credit.view;
    let renews: Bi | null = null;
    if (!v.trial && !v.paused && v.cycleEndsAt) {
      const tz = await this.venueTz(venueId);
      const day = (lang: 'ar' | 'en') =>
        new Intl.DateTimeFormat(lang === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB', { timeZone: tz, day: 'numeric', month: 'long' }).format(v.cycleEndsAt!);
      renews = bi(`والرصيد الشهري بيتجدد يوم ${day('ar')}.`, `The monthly credit renews on ${day('en')}.`);
    }
    return joinBi([
      bi('رصيد المساعد للمنشأة دي خلص.', 'This venue’s assistant credit is used up.'),
      rest,
      owner
        ? bi('علشان تشحن رصيد كلّم دعم ماتشنا.', 'To top it up, contact Matchena support.')
        : bi('بلّغ صاحب المنشأة علشان يشحن الرصيد.', 'Let the venue owner know so they can top it up.'),
      ...(renews ? [renews] : []),
    ]);
  }

  private blank(
    intent: AssistantPlan['intent'],
    reply: Bi,
    extra: Partial<AssistantPlan> = {},
  ): AssistantPlan {
    return {
      available: true,
      intent,
      confidence: 0,
      reply,
      summary: null,
      actions: [],
      schedule: null,
      query: null,
      issues: [],
      bookings: [],
      needsConfirm: false,
      ...extra,
    };
  }

  private issueReply(issues: AssistantIssue[], fallback: Bi): Bi {
    const blocking = issues.filter((i) => i.blocking);
    if (blocking.length)
      return joinBi(
        blocking.map((i) => i.message),
        '\n',
      );
    const warnings = issues.map((i) => i.message);
    return warnings.length ? joinBi([fallback, ...warnings], '\n') : fallback;
  }

  private async unitWordsFor(venueId: string) {
    const rows = await this.prisma.court.findMany({
      where: { venueId },
      select: { sport: { select: { activityKind: true } } },
    });
    return unitWords(rows.map((r) => r.sport?.activityKind));
  }

  private async helpText(venueId: string): Promise<Bi> {
    const rows = await this.prisma.court.findMany({
      where: { venueId },
      select: { name: true },
      orderBy: { name: 'asc' },
      take: 2,
    });
    const w = await this.unitWordsFor(venueId);
    const first = rows[0]?.name ?? `${w.ar.one} 1`;
    const second = rows[1]?.name ?? rows[0]?.name ?? `${w.ar.one} 2`;
    return bi(
      [
        'أقدر أساعدك في كل اللي بتعمله على الشاشة. اطلب بالعامية:',
        `• حجز: «احجز ${first} بكرة 9 الصبح ساعتين لمحمد بـ 400 دفع 200»`,
        '• تحصيل: «محمد دفع الباقي» — «مين عليه فلوس؟»',
        '• تعديل: «انقل حجز محمد للساعة 8» — «الغي حجز أحمد»',
        `• الجدول: «إيه حجوزات النهاردة؟» — «اقفل ${second} من 5 لـ 7»`,
        '• الحسابات: «عملت كام النهاردة؟» — «سجل 500 جنيه كهربا»',
      ].join('\n'),
      [
        'I can do anything you can do on this screen. Just ask:',
        `• Book: "book ${first} tomorrow 9am for two hours for Mohamed, 400, paid 200"`,
        '• Collect: "Mohamed paid the rest" — "who still owes me?"',
        '• Change: "move Mohamed to 8pm" — "cancel Ahmed\'s booking"',
        `• Schedule: "what is booked today?" — "close ${second} from 5 to 7"`,
        '• Money: "how much did I make today?" — "record a 500 electricity expense"',
      ].join('\n'),
    );
  }

  private clarify(r: AssistantReading): Bi {
    if (r.question) return bi(r.question, r.question);
    return bi(
      'مفهمتش قصدك بالظبط — تحب أعمل إيه؟ (حجز، تعديل حجز، تحصيل فلوس، قفل ميعاد، مصروف...)',
      'I did not quite get that — what would you like me to do? (a booking, a change, a payment, close a slot, an expense...)',
    );
  }

  private rangeLabel(range: string): Bi {
    const labels: Record<string, Bi> = {
      today: bi('النهاردة', 'Today'),
      yesterday: bi('إمبارح', 'Yesterday'),
      this_week: bi('الأسبوع ده', 'This week'),
      last_7_days: bi('آخر 7 أيام', 'Last 7 days'),
      this_month: bi('الشهر ده', 'This month'),
      last_month: bi('الشهر اللي فات', 'Last month'),
    };
    return labels[range] ?? labels['today'];
  }

  private expenseLabel(category: string, note: string): Bi {
    const labels: Record<string, Bi> = {
      electricity: bi('كهربا', 'electricity'),
      water: bi('مياه', 'water'),
      rent: bi('إيجار', 'rent'),
      salaries: bi('مرتبات', 'salaries'),
      maintenance: bi('صيانة', 'maintenance'),
      marketing: bi('تسويق', 'marketing'),
      supplies: bi('مستلزمات', 'supplies'),
      other: bi(note || 'مصروف', note || 'other'),
    };
    return labels[category] ?? labels['other'];
  }

  private async venueTz(venueId: string): Promise<string> {
    const venue = await this.prisma.venue.findUnique({
      where: { id: venueId },
      select: { country: { select: { timezone: true } } },
    });
    return venue?.country?.timezone ?? 'Africa/Cairo';
  }
}
