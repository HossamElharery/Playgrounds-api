import type { NluCourtRef } from './assistant-nlu.service';
import { resolveCourtFromText } from './assistant-courts';
import { bi, type AssistantReading, type Bi } from './assistant.types';

/**
 * Pure helpers of the owner assistant: text normalisation, the draft the
 * client echoes back, and joining a model reading with the pending question.
 * No database, no model — everything here is unit-testable on its own.
 */

export function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function hhmm(mins: number): string {
  return `${pad(Math.floor(mins / 60) % 24)}:${pad(mins % 60)}`;
}

export function joinBi(parts: Bi[], sep = ' '): Bi {
  return bi(parts.map((p) => p.ar).join(sep), parts.map((p) => p.en).join(sep));
}

/** Arabic spellings vary more than the owner does — compare on a flattened form. */
export function normalizeName(value: string): string {
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

export function todayIn(tz: string): string {
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
export function courtDetails(c: {
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
    typeof g['seats'] === 'number' || typeof g['seats'] === 'string'
      ? `${g['seats']} seats`
      : null,
    t['tableType'],
    c.format,
  ]
    .filter((x): x is string => typeof x === 'string' && x.length > 0)
    .join(' ');
}

/** The client echoes the draft back, so it is treated like any other untrusted input. */
export function sanitizeDraft(
  raw: Record<string, unknown> | undefined,
  courts: NluCourtRef[],
): AssistantReading | null {
  if (!raw || typeof raw !== 'object') return null;
  const intents: AssistantReading['intent'][] = [
    'block',
    'unblock',
    'book',
    'pay',
    'cancel',
    'move',
    'expense',
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
    typeof v === 'string'
      ? v
          .replace(/[<>;`$\\]/g, '')
          .slice(0, max)
          .trim()
      : '';
  const oneOf = <T extends string>(
    v: unknown,
    allowed: readonly T[],
  ): T | null => (allowed.includes(v as T) ? (v as T) : null);
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
    paymentMethod: oneOf(raw['paymentMethod'], [
      'cash',
      'instapay',
      'wallet',
      'card',
      'other',
    ] as const),
    sourceKey: oneOf(raw['sourceKey'], [
      'walk_in',
      'phone',
      'whatsapp',
      'other_platform',
    ] as const),
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

export const NEEDS_COURT: ReadonlySet<AssistantReading['intent']> = new Set([
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
