import { guestPhoneForStorage, normalizeGuestPhone } from '../../../common/utils/guest-phone.util';
import { quoteDurationPrice } from '../../../common/utils/price-quote.util';
import type { PricingRuleLike } from '../../../common/utils/pricing-rule.util';
import { zonedWallTimeToUtc, zonedWeekday } from '../../../common/utils/timezone.util';
import { isTimeWithinDayHours, type WeeklyHours } from '../../../common/utils/weekly-hours.util';
import {
  courtKey,
  durationUnitFromHeader,
  parseDate,
  parseDuration,
  parseMoneyMinor,
  parsePaymentMethod,
  parseSource,
  parseTime,
  type BookingField,
  type ColumnMapping,
  type ImportMethod,
  type ImportSourceKey,
} from './import-mapper.util';

export type IssueLevel = 'error' | 'warning';

export interface ImportIssue {
  code: string;
  level: IssueLevel;
  detail?: string;
}

export interface ImportCourt {
  id: string;
  name: string;
  slotDurationMins: number;
  pricingRules: Array<PricingRuleLike & { label?: string }>;
}

export interface ImportOptions {
  defaultCourtId?: string;
  defaultDurationMinutes?: number;
  ambiguousHours: 'am' | 'pm' | 'auto';
  whenPaidMissing: 'paid' | 'unpaid' | 'auto';
  defaultMethod: ImportMethod;
  defaultSourceLabel: string;
}

export const DEFAULT_IMPORT_OPTIONS: ImportOptions = {
  ambiguousHours: 'auto',
  whenPaidMissing: 'auto',
  defaultMethod: 'cash',
  defaultSourceLabel: 'استيراد من Excel',
};

export interface ImportContext {
  timeZone: string;
  countryCode?: string;
  now: Date;
  courts: ImportCourt[];
  weeklyHours: WeeklyHours | null;
  headers: string[];
  options: ImportOptions;
}

export interface NormalizedBooking {
  startsAt: Date;
  endsAt: Date;
  date: string;
  time: string;
  durationMinutes: number;
  courtId: string;
  courtName: string;
  priceAmount: number;
  paidAmount: number;
  paymentStatus: 'paid' | 'unpaid' | 'partial';
  paymentMethod: ImportMethod;
  customerName: string | null;
  customerPhone: string | null;
  sourceKey?: ImportSourceKey;
  sourceLabel?: string;
  notes: string | null;
}

export interface RowOutcome {
  booking?: NormalizedBooking;
  issues: ImportIssue[];
}

const hhmm = (minutes: number) => `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
const cell = (cells: string[], mapping: ColumnMapping, field: BookingField): string => {
  const idx = mapping[field];
  return idx == null ? '' : (cells[idx] ?? '').toString().trim();
};

const PAID_WORDS = /^(مدفوع|مدفوعه|تم|تم الدفع|دفع|خالص|واصل|paid|yes|y|true|✓|✔|نعم|اه|أه)$/i;
const UNPAID_WORDS = /^(غير مدفوع|مش مدفوع|لم يدفع|لسه|لا|no|n|false|unpaid|لم يتم|x|✗)$/i;

function matchCourt(name: string, courts: ImportCourt[]): ImportCourt | null {
  const key = courtKey(name);
  if (!key) return null;
  const exact = courts.filter((c) => courtKey(c.name) === key);
  if (exact.length === 1) return exact[0];
  const loose = courts.filter((c) => {
    const ck = courtKey(c.name);
    return ck.length > 0 && (ck.includes(key) || key.includes(ck));
  });
  return loose.length === 1 ? loose[0] : null;
}

export function normalizeBookingRow(cells: string[], mapping: ColumnMapping, ctx: ImportContext): RowOutcome {
  const issues: ImportIssue[] = [];
  const err = (code: string, detail?: string) => issues.push({ code, level: 'error', detail });
  const warn = (code: string, detail?: string) => issues.push({ code, level: 'warning', detail });
  const opts = ctx.options;

  const rawDate = cell(cells, mapping, 'date');
  const date = rawDate ? parseDate(rawDate, ctx.now) : null;
  if (!rawDate) err('DATE_MISSING');
  else if (!date) err('DATE_INVALID', rawDate);

  const rawTime = cell(cells, mapping, 'time');
  let startMinutes: number | null = null;
  let ambiguous = false;
  if (rawTime) {
    const t = parseTime(rawTime);
    if (!t) err('TIME_INVALID', rawTime);
    else {
      startMinutes = t.minutes;
      ambiguous = t.ambiguous;
    }
  } else if (date?.minutes != null) {
    startMinutes = date.minutes;
  } else {
    err('TIME_MISSING');
  }

  let court: ImportCourt | null = null;
  const rawCourt = cell(cells, mapping, 'court');
  if (rawCourt) {
    court = matchCourt(rawCourt, ctx.courts);
    if (!court) err('COURT_UNKNOWN', rawCourt);
  } else if (opts.defaultCourtId) {
    court = ctx.courts.find((c) => c.id === opts.defaultCourtId) ?? null;
    if (!court) err('COURT_REQUIRED');
  } else if (ctx.courts.length === 1) {
    court = ctx.courts[0];
  } else {
    err('COURT_REQUIRED');
  }

  if (!date || startMinutes == null) return { issues };

  if (ambiguous) {
    const open = (minutes: number) => {
      if (!ctx.weeklyHours) return null;
      const probe = zonedWallTimeToUtc(date.ymd, hhmm(minutes), ctx.timeZone);
      const day = ctx.weeklyHours[String(zonedWeekday(probe, ctx.timeZone))];
      return isTimeWithinDayHours(hhmm(minutes), day);
    };
    const pm = startMinutes + 720;
    let usePm: boolean;
    if (opts.ambiguousHours === 'pm') usePm = true;
    else if (opts.ambiguousHours === 'am') usePm = false;
    else {
      const amOpen = open(startMinutes);
      const pmOpen = open(pm);
      usePm = pmOpen === amOpen ? Math.floor(startMinutes / 60) <= 7 : !!pmOpen;
    }
    if (usePm) startMinutes = pm;
    warn('TIME_GUESSED', `${rawTime} → ${hhmm(startMinutes)}`);
  }

  let duration: number | null = null;
  const rawDuration = cell(cells, mapping, 'duration');
  const rawEnd = cell(cells, mapping, 'endTime');
  if (rawDuration) {
    const unitHeader = mapping.duration != null ? ctx.headers[mapping.duration] : '';
    duration = parseDuration(rawDuration, durationUnitFromHeader(unitHeader ?? ''));
    if (duration == null) err('DURATION_INVALID', rawDuration);
  } else if (rawEnd) {
    const end = parseTime(rawEnd);
    if (!end) err('TIME_INVALID', rawEnd);
    else {
      const span = (endMin: number) => ((endMin - startMinutes! + 1440) % 1440) || 1440;
      duration = end.ambiguous ? Math.min(span(end.minutes), span(end.minutes + 720)) : span(end.minutes);
    }
  } else {
    duration = opts.defaultDurationMinutes ?? court?.slotDurationMins ?? 60;
  }
  if (duration != null) {
    if (duration % 15 !== 0) {
      const rounded = Math.max(15, Math.round(duration / 15) * 15);
      warn('DURATION_ROUNDED', `${duration} → ${rounded}`);
      duration = rounded;
    }
    if (duration < 15 || duration > 720) {
      err('DURATION_INVALID', String(duration));
      duration = null;
    }
  }

  if (!court || duration == null) return { issues };

  const startsAt = zonedWallTimeToUtc(date.ymd, hhmm(startMinutes), ctx.timeZone);
  const endsAt = new Date(startsAt.getTime() + duration * 60_000);

  let price: number | null = null;
  const rawPrice = cell(cells, mapping, 'price');
  if (rawPrice) {
    price = parseMoneyMinor(rawPrice);
    if (price == null) err('PRICE_INVALID', rawPrice);
  } else {
    const quote = quoteDurationPrice(court.pricingRules, startsAt, duration, ctx.timeZone);
    if (quote.priceAmount != null) {
      price = quote.priceAmount;
      warn('PRICE_FROM_RATES');
    } else err('PRICE_MISSING');
  }
  if (price == null) return { issues };
  if (price === 0) warn('PRICE_ZERO');

  const rawPaid = cell(cells, mapping, 'paid');
  let paid: number;
  if (rawPaid && PAID_WORDS.test(rawPaid)) paid = price;
  else if (rawPaid && UNPAID_WORDS.test(rawPaid)) paid = 0;
  else if (rawPaid) {
    const parsed = parseMoneyMinor(rawPaid);
    if (parsed == null) {
      err('PAID_INVALID', rawPaid);
      return { issues };
    }
    paid = parsed;
  } else {
    const played = endsAt.getTime() <= ctx.now.getTime();
    paid = opts.whenPaidMissing === 'paid' ? price : opts.whenPaidMissing === 'unpaid' ? 0 : played ? price : 0;
  }
  if (paid > price) {
    warn('PAID_CLAMPED', `${paid / 100} → ${price / 100}`);
    paid = price;
  }
  const paymentStatus: NormalizedBooking['paymentStatus'] = paid >= price ? 'paid' : paid > 0 ? 'partial' : 'unpaid';

  const rawMethod = cell(cells, mapping, 'method');
  let method: ImportMethod = opts.defaultMethod;
  if (rawMethod) {
    const m = parsePaymentMethod(rawMethod);
    if (m) method = m;
    else warn('METHOD_UNKNOWN', rawMethod);
  }

  const name = cell(cells, mapping, 'customerName').slice(0, 80) || null;
  const rawPhone = cell(cells, mapping, 'phone');
  let phone: string | null = null;
  if (rawPhone) {
    phone = normalizeGuestPhone(rawPhone, ctx.countryCode);
    if (!phone) warn('PHONE_INVALID', rawPhone);
  }
  const src = parseSource(cell(cells, mapping, 'source'));
  const sourceLabel = src.key ? undefined : (src.label ?? opts.defaultSourceLabel);
  const notes = cell(cells, mapping, 'notes').slice(0, 500) || null;

  if (ctx.weeklyHours) {
    const day = ctx.weeklyHours[String(zonedWeekday(startsAt, ctx.timeZone))];
    if (!isTimeWithinDayHours(hhmm(startMinutes), day)) warn('OUTSIDE_HOURS');
  }

  return {
    issues,
    booking: {
      startsAt,
      endsAt,
      date: date.ymd,
      time: hhmm(startMinutes),
      durationMinutes: duration,
      courtId: court.id,
      courtName: court.name,
      priceAmount: price,
      paidAmount: paid,
      paymentStatus,
      paymentMethod: method,
      customerName: name,
      customerPhone: phone,
      sourceKey: src.key,
      sourceLabel,
      notes,
    },
  };
}

export function normalizeCustomerRow(cells: string[], mapping: ColumnMapping, countryCode = 'EG'): {
  customer?: { name: string | null; phone: string | null; note: string | null; key: string };
  issues: ImportIssue[];
} {
  const issues: ImportIssue[] = [];
  const name = cell(cells, mapping, 'customerName').slice(0, 80) || null;
  const rawPhone = cell(cells, mapping, 'phone');
  const phone = rawPhone ? normalizeGuestPhone(rawPhone, countryCode) : null;
  if (rawPhone && !phone) issues.push({ code: 'PHONE_INVALID', level: 'warning', detail: rawPhone });
  if (!name && !phone) {
    issues.push({ code: 'CUSTOMER_EMPTY', level: 'error' });
    return { issues };
  }
  const note = cell(cells, mapping, 'notes').slice(0, 500) || null;
  return { customer: { name, phone, note, key: customerKey(phone, name) }, issues };
}

export function customerKey(phone: string | null | undefined, name: string | null | undefined): string {
  if (phone) return `m:${guestPhoneForStorage(phone)}`;
  return `n:${(name ?? '').trim()}`;
}
