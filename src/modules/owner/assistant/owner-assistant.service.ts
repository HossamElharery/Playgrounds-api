import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { OwnerBookingsService } from '../owner-bookings.service';
import { OwnerSummaryService } from '../owner-summary.service';
import { ExpensesService } from '../expenses/expenses.service';
import { EXPENSE_CATEGORIES } from '../expenses/expenses.dto';
import {
  AssistantNluService,
  type NluCourtRef,
  type NluKnownBooking,
  type NluTurn,
} from './assistant-nlu.service';
import { resolveCourtFromText } from './assistant-courts';
import { findOwed } from './assistant-attention';
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
import {
  zonedHhmm,
  zonedWallTimeToUtc,
  zonedDayBounds,
} from '../../../common/utils/timezone.util';

/** Below this the model is guessing, and a guess here writes money into the books. */
const MIN_CONFIDENCE = 0.35;
/** One sentence never legitimately asks for more than this. */
const MAX_ACTIONS = 4;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function hhmm(mins: number): string {
  return `${pad(Math.floor(mins / 60) % 24)}:${pad(mins % 60)}`;
}

function joinBi(parts: Bi[], sep = ' '): Bi {
  return bi(parts.map((p) => p.ar).join(sep), parts.map((p) => p.en).join(sep));
}

/** Arabic spellings vary more than the owner does — compare on a flattened form. */
function normalizeName(value: string): string {
  return value
    .replace(/\u0640/g, '')
    .replace(/[\u064B-\u0652]/gu, '')
    .replace(/[إأآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function todayIn(tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
}

/** YYYY-MM-DD + 1 calendar day (no timezone maths: it is a date, not an instant). */
export function nextDay(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/** "أيوه" / "yes" to a proposal the assistant just made. */
export function isAffirmative(text: string): boolean {
  return /^\s*(ا?ي?وه|اه|أه|آه|ايوا|أيوا|اكيد|أكيد|تمام|ماشي|ok|okay|yes|yep|yeah|sure|اة|اي)\s*[.!،]*\s*$/i.test(
    text.replace(/[\u064B-\u0652]/g, ''),
  );
}

/** Console type, room tier, sport and format — the words an owner uses instead of the court's name. */
function courtDetails(c: {
  format: string | null;
  gamingConfig: unknown;
  tableConfig: unknown;
  sport: { nameEn: string; nameAr: string } | null;
}): string {
  const g = (c.gamingConfig ?? {}) as Record<string, unknown>;
  const t = (c.tableConfig ?? {}) as Record<string, unknown>;
  return [
    c.sport?.nameEn,
    c.sport?.nameAr,
    g['consoleType'],
    g['roomTier'],
    g['seats'] ? `${g['seats']} seats` : null,
    t['tableType'],
    c.format,
  ]
    .filter((x): x is string => typeof x === 'string' && x.length > 0)
    .join(' ');
}

/** The client echoes the draft back, so it is treated like any other untrusted input. */
function sanitizeDraft(
  raw: Record<string, unknown> | undefined,
  courts: NluCourtRef[],
): AssistantReading | null {
  if (!raw || typeof raw !== 'object') return null;
  const intents: AssistantReading['intent'][] = [
    'block', 'unblock', 'book', 'pay', 'cancel', 'move', 'expense',
  ];
  const intent = raw['intent'] as AssistantReading['intent'];
  if (!intents.includes(intent)) return null;
  const valid = new Set(courts.map((c) => c.id));
  const num = (v: unknown, min: number, max: number): number | null => {
    const n = Number(v);
    return v !== null && v !== '' && Number.isFinite(n) && n >= min && n <= max
      ? n
      : null;
  };
  const str = (v: unknown, max: number) =>
    typeof v === 'string' ? v.replace(/[<>;`$\\]/g, '').slice(0, max).trim() : '';
  const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): T | null =>
    allowed.includes(v as T) ? (v as T) : null;
  const ids = Array.isArray(raw['courtIds'])
    ? (raw['courtIds'] as unknown[]).filter(
        (id): id is string => typeof id === 'string' && valid.has(id),
      )
    : [];
  return {
    intent,
    courtIds: ids,
    allCourts: raw['allCourts'] === true && ids.length === 0,
    date: /^\d{4}-\d{2}-\d{2}$/.test(String(raw['date']))
      ? String(raw['date'])
      : '',
    fromMins: num(raw['fromMins'], 0, 1440),
    toMins: num(raw['toMins'], 0, 1440),
    durationMinutes: num(raw['durationMinutes'], 15, 720),
    customerName: str(raw['customerName'], 80),
    customerPhone: str(raw['customerPhone'], 32).replace(/[^\d+]/g, ''),
    totalAmount: num(raw['totalAmount'], 0, 1_000_000),
    paidAmount: num(raw['paidAmount'], 0, 1_000_000),
    remainingAmount: num(raw['remainingAmount'], 0, 1_000_000),
    paymentMethod: oneOf(raw['paymentMethod'], ['cash', 'instapay', 'wallet', 'card', 'other'] as const),
    sourceKey: oneOf(raw['sourceKey'], ['walk_in', 'phone', 'whatsapp', 'other_platform'] as const),
    expenseCategory: str(raw['expenseCategory'], 30) || null,
    rangeKey: null,
    reason: str(raw['reason'], 120),
    confidence: 0.6,
    newDate: /^\d{4}-\d{2}-\d{2}$/.test(String(raw['newDate']))
      ? String(raw['newDate'])
      : null,
    newFromMins: num(raw['newFromMins'], 0, 1440),
    newCourtId:
      typeof raw['newCourtId'] === 'string' && valid.has(raw['newCourtId'])
        ? raw['newCourtId']
        : null,
    question: '',
  };
}

const NEEDS_COURT: ReadonlySet<AssistantReading['intent']> = new Set([
  'book',
  'block',
  'unblock',
  'free',
  'agenda',
]);

/**
 * Joins the model's reading with what the assistant was already waiting for,
 * then fills in what plain string matching can do better than a model: an
 * answer like "PS5 Room 1" to "which court?" must never be lost.
 */
export function completeReading(
  reading: AssistantReading,
  draft: AssistantReading | null,
  text: string,
  courts: NluCourtRef[],
): AssistantReading {
  let r = { ...reading };
  const resolved = () =>
    resolveCourtFromText(
      text,
      courts.map((c) => ({ id: c.id, name: c.name, hints: c.details })),
    );

  if (draft && r.intent === 'unknown' && isAffirmative(text)) {
    // "أيوه" to "تقصد بكرة؟": the draft already holds the proposal.
    r = { ...draft, confidence: Math.max(r.confidence, 0.8), question: '' };
  } else if (draft && r.intent === 'unknown') {
    // The model lost the thread. If the sentence at least names a court, it is
    // the answer to the pending question.
    const court = draft.courtIds.length ? null : resolved();
    if (court) {
      r = {
        ...draft,
        courtIds: [court],
        date: draft.date || r.date,
        confidence: Math.max(r.confidence, 0.6),
        question: '',
      };
    }
  } else if (draft && r.intent === draft.intent) {
    r = {
      ...r,
      courtIds: r.courtIds.length ? r.courtIds : draft.courtIds,
      allCourts: r.allCourts || (draft.allCourts && !r.courtIds.length),
      fromMins: r.fromMins ?? draft.fromMins,
      toMins: r.toMins ?? draft.toMins,
      durationMinutes: r.durationMinutes ?? draft.durationMinutes,
      customerName: r.customerName || draft.customerName,
      customerPhone: r.customerPhone || draft.customerPhone,
      totalAmount: r.totalAmount ?? draft.totalAmount,
      paidAmount: r.paidAmount ?? draft.paidAmount,
      remainingAmount: r.remainingAmount ?? draft.remainingAmount,
      paymentMethod: r.paymentMethod ?? draft.paymentMethod,
      sourceKey: r.sourceKey ?? draft.sourceKey,
      reason: r.reason || draft.reason,
      newDate: r.newDate ?? draft.newDate,
      newFromMins: r.newFromMins ?? draft.newFromMins,
      newCourtId: r.newCourtId ?? draft.newCourtId,
    };
  }

  if (NEEDS_COURT.has(r.intent) && !r.courtIds.length && !r.allCourts) {
    const court = resolved();
    if (court) r.courtIds = [court];
  }
  if (r.intent === 'move' && !r.newCourtId && !r.courtIds.length) {
    // "انقل حجز محمد للـ VIP" — the court in the sentence is the destination.
    const court = resolved();
    if (court) r.newCourtId = court;
  }
  return r;
}

/**
 * The owner's assistant. The NLU proposes a reading of the sentence; this
 * service is the part that knows what is actually true — real courts, real
 * prices, real money already collected — and turns a reading into either a
 * plain answer or a plan the owner confirms.
 *
 * Two rules hold everywhere below:
 *  1. Nothing the model says about money is trusted. Every amount is
 *     re-derived from the venue's own tariff and payment rows, and a sentence
 *     whose numbers contradict each other is refused, never "rounded into"
 *     the books.
 *  2. Execution goes through the same services the dashboard's own buttons
 *     use, so an assistant action can never do something the owner (or a
 *     staff member with fewer permissions) could not do by hand.
 */
@Injectable()
export class OwnerAssistantService {
  private readonly logger = new Logger(OwnerAssistantService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly nlu: AssistantNluService,
    private readonly bookings: OwnerBookingsService,
    private readonly summary: OwnerSummaryService,
    private readonly expenses: ExpensesService,
  ) {}

  get enabled(): boolean {
    return this.nlu.enabled;
  }

  // ---------------------------------------------------------------- ask ----

  async ask(
    user: AuthenticatedUser,
    venueId: string,
    text: string,
    extra: { history?: NluTurn[]; draft?: Record<string, unknown> } = {},
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
      this.openBalanceBookings(venueId, tz, today),
    ]);
    const courts: NluCourtRef[] = courtRows.map((c) => ({
      id: c.id,
      name: c.name,
      details: courtDetails(c),
    }));

    const known: NluKnownBooking[] = openBalances.map((b) => ({
      name: b.customerName ?? '',
      courtName: b.courtName,
      time: zonedHhmm(new Date(b.startsAt), tz),
      outstanding: Math.round(b.outstanding / 100),
    }));

    const draft = sanitizeDraft(extra.draft, courts);
    const raw = await this.nlu.read(clean, courts, today, known, {
      venueName: venue.nameAr || venue.nameEn,
      nowHhmm: zonedHhmm(new Date(), tz),
      history: extra.history,
      draft,
    });
    if (!raw) return this.blank('unknown', bi('', ''), { available: false });
    const reading = completeReading(raw, draft, clean, courts);

    if (reading.confidence < MIN_CONFIDENCE || reading.intent === 'unknown') {
      // A question about what they meant beats a canned menu — and an
      // unfinished request stays alive across a stray "شكرًا".
      return this.blank('unknown', this.clarify(reading), {
        confidence: reading.confidence,
        draft,
      });
    }
    if (reading.intent === 'help') return this.blank('help', this.helpText());

    const currency = venue.priceFromCurrency ?? 'EGP';
    try {
      switch (reading.intent) {
        case 'book':
          return await this.planBook(user, venueId, tz, currency, reading);
        case 'pay':
          return await this.planPay(user, venueId, tz, currency, reading);
        case 'cancel':
          return await this.planCancel(user, venueId, tz, currency, reading);
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

  // --------------------------------------------------------------- book ----

  /**
   * The heart of the module: put a real customer, on a real court, with real
   * money, into the books — and refuse when the owner's own numbers do not
   * survive arithmetic.
   */
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
      include: { pricingRules: true },
      orderBy: { name: 'asc' },
    });
    if (!courts.length) {
      return this.blank(
        'book',
        bi('المنشأة دي لسه مفيهاش ملاعب.', 'This venue has no courts yet.'),
      );
    }
    const court = r.courtIds.length
      ? courts.find((c) => c.id === r.courtIds[0])
      : courts.length === 1
        ? courts[0]
        : undefined;
    if (!court) {
      return this.blank(
        'book',
        bi(
          `أي ملعب بالظبط؟ عندك: ${courts.map((c) => c.name).join('، ')}.`,
          `Which one exactly? You have: ${courts.map((c) => c.name).join(', ')}.`,
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
      // "بكرة" is far more likely than "yesterday's 2pm": offer it, and a bare
      // "أيوه" next turn books it.
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
        // The owner closed this on purpose. Never overwrite that silently —
        // and never refuse either: they may simply have changed their mind.
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
    // Nothing said about money at all: the booking goes in unpaid at the
    // tariff, and "محمد دفع" collects it later. Assuming it was paid would put
    // cash in the books that nobody handed over.
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

  /** Delegates to the pure reconciler, and carries its findings into the plan's issue list. */
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

  // ---------------------------------------------------------------- pay ----

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

  // ------------------------------------------------------------- cancel ----

  private async planCancel(
    user: AuthenticatedUser,
    venueId: string,
    tz: string,
    currency: string,
    r: AssistantReading,
  ): Promise<AssistantPlan> {
    if (!(await this.can(user, venueId, 'bookings.edit')))
      return this.denied('cancel');
    const candidates = await this.findBookings(venueId, tz, r, {
      onlyOwing: false,
    });
    const picked = this.pickOne(candidates, r, currency, tz);
    if ('issue' in picked) return picked.plan;
    const booking = picked.booking;

    const summary = bi(
      `إلغاء حجز ${booking.customerName ?? booking.code} في ${booking.courtName} ` +
        `${zonedHhmm(new Date(booking.startsAt), tz)}` +
        (booking.paidAmount > 0
          ? ` — كان مدفوع فيه ${fmt(booking.paidAmount, currency).ar}، هتتراجع في الحسابات.`
          : '.'),
      `Cancel ${booking.customerName ?? booking.code} on ${booking.courtName} ` +
        `${zonedHhmm(new Date(booking.startsAt), tz)}` +
        (booking.paidAmount > 0
          ? ` — ${fmt(booking.paidAmount, currency).en} was already paid; the books will reflect that.`
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
        },
      ],
      schedule: null,
      query: null,
      issues: [],
      bookings: [booking],
      needsConfirm: true,
    };
  }

  // -------------------------------------------------------------- money ----

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
        `${label.ar}: ${t.bookings} حجز، حصّلت ${fmt(t.collectedRevenue, currency).ar}.`,
        `${label.en}: ${t.bookings} bookings, ${fmt(t.collectedRevenue, currency).en} collected.`,
      ),
    ];
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
        `الصافي بعد عمولة متشينا والمصاريف: ${fmt(t.netProfit, currency).ar}.`,
        `Net after Matchena's commission and expenses: ${fmt(t.netProfit, currency).en}.`,
      ),
    );
    return this.blank('money', joinBi(lines, '\n'), {
      confidence: r.confidence,
    });
  }

  // -------------------------------------------------------------- debts ----

  private async planDebts(
    user: AuthenticatedUser,
    venueId: string,
    tz: string,
    currency: string,
    r: AssistantReading,
  ): Promise<AssistantPlan> {
    if (!(await this.can(user, venueId, 'bookings.view')))
      return this.denied('debts');
    const rows = await this.openBalanceBookings(venueId, tz, r.date);
    if (!rows.length) {
      return this.blank(
        'debts',
        bi(
          'محدش عليه فلوس — كله خالص ✅',
          'Nobody owes you anything — all settled ✅',
        ),
        { confidence: r.confidence },
      );
    }
    const total = rows.reduce((sum, b) => sum + b.outstanding, 0);
    const lines = rows
      .slice(0, 10)
      .map((b) =>
        bi(
          `• ${b.customerName ?? b.code} — ${fmt(b.outstanding, currency).ar} (${b.courtName} ${zonedHhmm(new Date(b.startsAt), tz)})`,
          `• ${b.customerName ?? b.code} — ${fmt(b.outstanding, currency).en} (${b.courtName} ${zonedHhmm(new Date(b.startsAt), tz)})`,
        ),
      );
    const head = bi(
      `${rows.length} حجز عليهم ${fmt(total, currency).ar}:`,
      `${rows.length} bookings owe you ${fmt(total, currency).en}:`,
    );
    return {
      ...this.blank('debts', joinBi([head, ...lines], '\n'), {
        confidence: r.confidence,
      }),
      bookings: rows.slice(0, 10),
    };
  }

  // ------------------------------------------------------------ expense ----

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

  // ----------------------------------------------------- schedule / free ----

  /**
   * Block and unblock stay on the day board: it already owns block splitting,
   * the optimistic overlay and the undo token. The assistant's job here is
   * only to say *what* the owner meant, accurately.
   */
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
      return this.blank(
        r.intent,
        bi(
          `أي ملعب بالظبط؟ عندك: ${courts.map((c) => c.name).join('، ')} — أو قول «كله».`,
          `Which one? You have: ${courts.map((c) => c.name).join(', ')} — or say "all".`,
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

  // ------------------------------------------------------------- agenda ----

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
        payments: { where: { status: 'paid' }, select: { amount: true } },
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

  // --------------------------------------------------------------- move ----

  /** Reschedule, resize or re-price an existing booking — one confirm card, one update. */
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
    // On a move the court in the sentence is usually the *new* place, so the
    // booking is found by name and date; the time only narrows it when the
    // owner also gave a new one (then `fromMins` is the old time).
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
      return this.blank(
        'move',
        bi(
          `تمام، حجز ${who}. تعدّل فيه إيه — الوقت، الملعب، المدة ولا السعر؟`,
          `OK, ${who}'s booking. What should change — time, court, length or price?`,
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

  // ------------------------------------------------------------ execute ----

  /**
   * Runs a confirmed plan. Every action goes through the same service the
   * dashboard's own button calls, so permissions, overpayment guards, slot
   * conflicts and the ledger behave identically — the assistant is a faster
   * way to press the buttons, never a way around them.
   */
  async execute(
    user: AuthenticatedUser,
    venueId: string,
    actions: AssistantAction[],
  ): Promise<{ ok: boolean; reply: Bi; done: string[] }> {
    const venue = await assertVenueAccess(this.prisma, user, venueId, {
      write: true,
    });
    if (!actions.length || actions.length > MAX_ACTIONS) {
      throw new BadRequestException(
        `actions must contain 1-${MAX_ACTIONS} items`,
      );
    }
    const currency = venue.priceFromCurrency ?? 'EGP';
    const done: string[] = [];
    const lines: Bi[] = [];

    // The granular permission lives on the dashboard's own routes, so calling
    // the services straight from here would hand a limited staff account the
    // keys it was never given. Re-check per action, by the same catalogue.
    const needed: Record<AssistantAction['kind'], PermissionKey> = {
      create_booking: 'bookings.create',
      record_payment: 'payments.record',
      cancel_booking: 'bookings.edit',
      add_expense: 'expenses.manage',
      update_booking: 'bookings.edit',
    };
    for (const action of actions) {
      if (!(await this.can(user, venueId, needed[action.kind]))) {
        throw new ForbiddenException(
          `Missing permission: ${needed[action.kind]}`,
        );
      }
      // The action DTO cannot express "these fields are required for this
      // kind", and a half-filled action reaches Prisma as an undefined id or a
      // NaN amount. Check the shape once, here, before anything is written.
      this.assertActionShape(action);
    }

    for (const action of actions) {
      switch (action.kind) {
        case 'create_booking': {
          let restore: (() => Promise<void>) | undefined;
          if (action.overrideBlocks) {
            if (!(await this.can(user, venueId, 'schedule.manage'))) {
              throw new ForbiddenException('Missing permission: schedule.manage');
            }
            const from = new Date(action.startsAt);
            restore = await this.carveBlocks(
              venueId,
              action.courtId,
              from,
              new Date(from.getTime() + action.durationMinutes * 60_000),
            );
          }
          let booking;
          try {
            booking = await this.bookings.createManualBooking(user, {
              venueId,
              courtId: action.courtId,
              startsAt: action.startsAt,
              durationMinutes: action.durationMinutes,
              priceAmount: action.priceAmount,
              paymentStatus: action.paymentStatus,
              paidAmount: action.paidAmount,
              paymentMethod: action.paymentMethod,
              customerName: action.customerName,
              customerPhone: action.customerPhone,
              sourceKey: action.sourceKey,
              notes: action.notes,
            });
          } catch (err) {
            // The block was opened for this booking only; if it fell through,
            // the window goes back to exactly how the owner left it.
            await restore?.();
            throw err;
          }
          done.push(booking.id);
          lines.push(
            bi(
              `اتسجل الحجز ✅ (${booking.code})`,
              `Booking recorded ✅ (${booking.code})`,
            ),
          );
          break;
        }
        case 'record_payment': {
          const booking = await this.bookings.addManualPayment(
            user,
            action.bookingId,
            action.amount,
            action.method,
          );
          done.push(booking.id);
          const left = booking.money?.outstanding ?? 0;
          lines.push(
            left > 0
              ? bi(
                  `اتسجل الدفع ✅ باقي ${fmt(left, currency).ar}.`,
                  `Payment recorded ✅ ${fmt(left, currency).en} still outstanding.`,
                )
              : bi(
                  'اتسجل الدفع والحجز خالص ✅',
                  'Payment recorded — fully settled ✅',
                ),
          );
          break;
        }
        case 'cancel_booking': {
          const booking = await this.bookings.deleteManualBooking(
            user,
            action.bookingId,
          );
          done.push(booking.id);
          lines.push(bi('اتلغى الحجز ✅', 'Booking cancelled ✅'));
          break;
        }
        case 'update_booking': {
          const booking = await this.bookings.updateManualBooking(
            user,
            action.bookingId,
            {
              courtId: action.courtId,
              startsAt: action.startsAt,
              durationMinutes: action.durationMinutes,
              priceAmount: action.priceAmount,
            },
          );
          done.push(booking.id);
          lines.push(bi('اتعدّل الحجز ✅', 'Booking updated ✅'));
          break;
        }
        case 'add_expense': {
          const expense = await this.expenses.create(user, {
            venueId,
            category: action.category as never,
            categoryLabel:
              action.category === 'other'
                ? action.note?.slice(0, 60) || 'مصروف'
                : undefined,
            amount: action.amount,
            incurredOn: action.incurredOn,
            note: action.note,
          });
          done.push(expense.id);
          lines.push(bi('اتسجل المصروف ✅', 'Expense recorded ✅'));
          break;
        }
        default:
          throw new BadRequestException('Unsupported action');
      }
    }
    return { ok: true, reply: joinBi(lines, '\n'), done };
  }

  private assertActionShape(action: AssistantAction): void {
    const need = (ok: unknown, field: string) => {
      if (!ok)
        throw new BadRequestException(`${action.kind} requires ${field}`);
    };
    switch (action.kind) {
      case 'create_booking':
        need(action.courtId, 'courtId');
        need(
          action.startsAt && !Number.isNaN(Date.parse(action.startsAt)),
          'startsAt',
        );
        need(
          Number.isInteger(action.durationMinutes) &&
            action.durationMinutes > 0,
          'durationMinutes',
        );
        need(
          Number.isInteger(action.priceAmount) && action.priceAmount >= 0,
          'priceAmount',
        );
        need(
          ['paid', 'unpaid', 'partial'].includes(action.paymentStatus),
          'paymentStatus',
        );
        if (action.paymentStatus === 'partial') {
          need(
            Number.isInteger(action.paidAmount) &&
              (action.paidAmount as number) > 0 &&
              (action.paidAmount as number) < action.priceAmount,
            'paidAmount between 0 and priceAmount',
          );
        }
        break;
      case 'record_payment':
        need(action.bookingId, 'bookingId');
        need(
          Number.isInteger(action.amount) && action.amount > 0,
          'a positive amount',
        );
        break;
      case 'cancel_booking':
        need(action.bookingId, 'bookingId');
        break;
      case 'update_booking':
        need(action.bookingId, 'bookingId');
        need(
          action.courtId ||
            action.startsAt ||
            action.durationMinutes ||
            action.priceAmount !== undefined,
          'at least one change',
        );
        if (action.startsAt)
          need(!Number.isNaN(Date.parse(action.startsAt)), 'startsAt');
        break;
      case 'add_expense':
        need(
          EXPENSE_CATEGORIES.includes(
            action.category as (typeof EXPENSE_CATEGORIES)[number],
          ),
          'a known category',
        );
        need(
          Number.isInteger(action.amount) && action.amount > 0,
          'a positive amount',
        );
        need(
          /^\d{4}-\d{2}-\d{2}$/.test(action.incurredOn),
          'incurredOn as YYYY-MM-DD',
        );
        break;
    }
  }

  // ---------------------------------------------------------- attention ----

  /** Everything worth the owner's eye right now: money owed, arrivals with a balance, tomorrow. */
  async attention(
    user: AuthenticatedUser,
    venueId: string,
    tz: string,
    currency: string,
  ): Promise<AssistantPlan> {
    if (!(await this.can(user, venueId, 'bookings.view')))
      return this.denied('attention');
    const now = new Date();
    const [overdue, soon] = await Promise.all([
      findOwed(this.prisma, { venueId }, { kind: 'overdue', now }),
      findOwed(
        this.prisma,
        { venueId },
        { kind: 'upcoming', from: now, to: new Date(now.getTime() + 3 * 3_600_000) },
      ),
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
        bi('كله تمام ✅ مفيش فلوس متأخرة ولا حاجة محتاجة انتباه.', 'All clear ✅ nothing overdue.'),
      );
    }
    return {
      ...this.blank('attention', joinBi(lines, '\n'), { confidence: 1 }),
      // Lets the dashboard decide whether the digest deserves a message of its own.
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

  /** Public entry for the dashboard's proactive message. */
  async attentionDigest(user: AuthenticatedUser, venueId: string) {
    const venue = await assertVenueAccess(this.prisma, user, venueId, {
      write: false,
    });
    const tz = await this.venueTz(venueId);
    return this.attention(user, venueId, tz, venue.priceFromCurrency ?? 'EGP');
  }

  // ------------------------------------------------------ smart-guard bits ----

  /** Free options near a taken window: other courts at the same time, then nearby times on this one. */
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

  /**
   * Opens [start, end) on one court out of any block that covers it, keeping
   * whatever is left of the block on either side (and, for a venue-wide block,
   * on every other court). Returns a function that puts everything back.
   */
  private async carveBlocks(
    venueId: string,
    courtId: string,
    start: Date,
    end: Date,
  ): Promise<() => Promise<void>> {
    const blocks = await this.prisma.calendarBlock.findMany({
      where: {
        venueId,
        OR: [{ courtId }, { courtId: null }],
        startsAt: { lt: end },
        endsAt: { gt: start },
      },
    });
    if (!blocks.length) return async () => undefined;
    const others = await this.prisma.court.findMany({
      where: { venueId, id: { not: courtId } },
      select: { id: true },
    });
    const created: string[] = [];
    await this.prisma.$transaction(async (tx) => {
      for (const b of blocks) {
        await tx.calendarBlock.delete({ where: { id: b.id } });
        const make = async (cid: string | null, from: Date, to: Date) => {
          if (to.getTime() <= from.getTime()) return;
          const row = await tx.calendarBlock.create({
            data: {
              venueId,
              courtId: cid,
              kind: b.kind,
              startsAt: from,
              endsAt: to,
              note: b.note,
              createdById: b.createdById,
            },
          });
          created.push(row.id);
        };
        await make(b.courtId, b.startsAt, new Date(Math.min(start.getTime(), b.endsAt.getTime())));
        await make(b.courtId, new Date(Math.max(end.getTime(), b.startsAt.getTime())), b.endsAt);
        if (b.courtId === null) {
          const from = new Date(Math.max(start.getTime(), b.startsAt.getTime()));
          const to = new Date(Math.min(end.getTime(), b.endsAt.getTime()));
          for (const o of others) await make(o.id, from, to);
        }
      }
    });
    return async () => {
      await this.prisma.$transaction(async (tx) => {
        await tx.calendarBlock.deleteMany({ where: { id: { in: created } } });
        await tx.calendarBlock.createMany({ data: blocks });
      });
    };
  }

  // ------------------------------------------------------------ helpers ----

  /** Manual bookings with money still on them, for the day asked about and the week after it. */
  private async openBalanceBookings(
    venueId: string,
    tz: string,
    date: string,
  ): Promise<AssistantBookingRef[]> {
    const { start } = zonedDayBounds(date, tz);
    const end = new Date(start.getTime() + 7 * 86_400_000);
    const rows = await this.prisma.booking.findMany({
      where: {
        venueId,
        source: 'manual',
        status: { not: 'cancelled' },
        paymentStatus: { in: ['pending', 'partial'] },
        slotStart: { gte: start, lt: end },
      },
      include: {
        court: { select: { name: true } },
        payments: { where: { status: 'paid' }, select: { amount: true } },
      },
      orderBy: { slotStart: 'asc' },
      take: 50,
    });
    return rows.map((b) => this.toRef(b));
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

  /**
   * Finds the booking the owner is talking about. The name is matched loosely
   * (Arabic spelling drifts), the day comes from the sentence, and the search
   * widens to the coming week when today has no match — owners say "محمد"
   * about tomorrow's booking as often as today's.
   */
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
        where: { status: 'paid' as const },
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
    // A stated time narrows it further, but only if something actually matches.
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

  /** Zero or many matches is a question, never a guess — money is about to move. */
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

  /** A blocking issue replaces the summary; a warning rides along with it. */
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

  private helpText(): Bi {
    return bi(
      [
        'أقدر أساعدك في كل اللي بتعمله على الشاشة. اطلب بالعامية:',
        '• حجز: «احجز PS5 Room 1 بكرة 9 الصبح ساعتين لمحمد بـ 400 دفع 200»',
        '• تحصيل: «محمد دفع الباقي» — «مين عليه فلوس؟»',
        '• تعديل: «انقل حجز محمد للساعة 8» — «الغي حجز أحمد»',
        '• الجدول: «إيه حجوزات النهاردة؟» — «اقفل جهاز 2 من 5 لـ 7»',
        '• الحسابات: «عملت كام النهاردة؟» — «سجل 500 جنيه كهربا»',
      ].join('\n'),
      [
        'I can do anything you can do on this screen. Just ask:',
        '• Book: "book PS5 Room 1 tomorrow 9am for two hours for Mohamed, 400, paid 200"',
        '• Collect: "Mohamed paid the rest" — "who still owes me?"',
        '• Change: "move Mohamed to 8pm" — "cancel Ahmed\'s booking"',
        '• Schedule: "what is booked today?" — "close station 2 from 5 to 7"',
        '• Money: "how much did I make today?" — "record a 500 electricity expense"',
      ].join('\n'),
    );
  }

  /** What to say when the sentence did not become a plan: the model's own question, else a short one. */
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
