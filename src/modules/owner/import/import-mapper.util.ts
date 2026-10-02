import { asciiDigits } from '../../../common/utils/guest-phone.util';

/**
 * Understands what an Egyptian venue's spreadsheet means: Arabic or English headers, Arabic or
 * Western digits, day-first dates, "6 م" hours, "ساعة ونص" durations, "1,500 ج" prices. Every parser
 * is pure and returns null instead of guessing wildly, so the preview can tell the owner exactly
 * which cell it did not understand.
 */

export const BOOKING_FIELDS = [
  'date',
  'time',
  'endTime',
  'duration',
  'court',
  'phone',
  'customerName',
  'price',
  'paid',
  'method',
  'source',
  'notes',
] as const;
export type BookingField = (typeof BOOKING_FIELDS)[number];

export type ColumnMapping = Partial<Record<BookingField, number | null>>;

const HEADER_WORDS: Record<BookingField, string[]> = {
  date: ['date', 'day', 'تاريخ', 'التاريخ', 'اليوم', 'يوم', 'تاريخ الحجز', 'يوم الحجز'],
  time: ['time', 'start', 'from', 'starttime', 'start time', 'الساعة', 'الساعه', 'الوقت', 'وقت', 'من', 'بداية', 'البداية', 'ساعة', 'وقت البدء', 'ميعاد', 'الميعاد', 'الموعد', 'معاد', 'المعاد', 'وقت الحجز'],
  endTime: ['end', 'to', 'endtime', 'end time', 'الي', 'إلى', 'الى', 'نهاية', 'النهاية', 'وقت الانتهاء', 'لحد', 'حتى', 'وقت النهاية'],
  duration: ['duration', 'hours', 'minutes', 'mins', 'length', 'مدة', 'المدة', 'مده', 'المده', 'عدد الساعات', 'ساعات', 'دقائق', 'عدد ساعات'],
  court: ['court', 'pitch', 'field', 'unit', 'table', 'ground', 'ملعب', 'الملعب', 'ملاعب', 'وحدة', 'الوحدة', 'طاولة', 'ترابيزة', 'الترابيزة', 'ستاد', 'استاد', 'الأرض', 'الارض', 'رقم الملعب', 'اسم الملعب'],
  phone: ['phone', 'mobile', 'tel', 'whatsapp', 'cell', 'موبايل', 'المحمول', 'محمول', 'تليفون', 'التليفون', 'رقم', 'رقم الموبايل', 'رقم التليفون', 'هاتف', 'الهاتف', 'رقم الهاتف', 'واتساب', 'تلفون', 'رقم الجوال', 'جوال', 'تليفون العميل', 'موبايل العميل'],
  customerName: ['name', 'customer', 'client', 'guest', 'الاسم', 'اسم', 'العميل', 'اسم العميل', 'اللاعب', 'الكابتن', 'كابتن', 'الحاجز', 'حاجز', 'صاحب الحجز', 'اسم الحاجز', 'عميل'],
  price: ['price', 'total', 'amount', 'cost', 'سعر', 'السعر', 'الاجمالي', 'الإجمالي', 'اجمالي', 'إجمالي', 'المبلغ', 'قيمة', 'القيمة', 'التكلفة', 'الحساب', 'سعر الحجز', 'اجمالى', 'الاجمالى'],
  paid: ['paid', 'deposit', 'received', 'مدفوع', 'المدفوع', 'دفع', 'عربون', 'العربون', 'المقدم', 'مقدم', 'المستلم', 'دفعة', 'واصل', 'الواصل', 'المدفوعات'],
  method: ['method', 'payment', 'paymentmethod', 'payment method', 'طريقة الدفع', 'الدفع', 'وسيلة الدفع', 'نوع الدفع', 'طريقه الدفع'],
  source: ['source', 'channel', 'المصدر', 'مصدر', 'القناة', 'طريقة الحجز', 'طريقه الحجز', 'جاي منين', 'اتحجز ازاي'],
  notes: ['notes', 'note', 'remark', 'comment', 'ملاحظات', 'ملاحظة', 'ملاحظه', 'تعليق', 'ملحوظات', 'ملحوظة'],
};

const ASSIGN_ORDER: BookingField[] = ['date', 'time', 'endTime', 'duration', 'court', 'phone', 'customerName', 'price', 'paid', 'method', 'source', 'notes'];

/** Lower-case, no diacritics, no "ال", one spelling of alef/yaa/taa-marbuta, single spaces. */
export function normalizeHeader(text: string): string {
  return asciiDigits(text)
    .normalize('NFKC')
    .toLocaleLowerCase('en')
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[^\p{L}\p{N} ]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const WORDS: Record<BookingField, Set<string>> = Object.fromEntries(
  BOOKING_FIELDS.map((f) => [f, new Set(HEADER_WORDS[f].map(normalizeHeader))]),
) as Record<BookingField, Set<string>>;

const stripAl = (h: string) => h.replace(/^ال/, '');

/** Which column is which, judged by the header row alone. Each column is used at most once. */
export function suggestMapping(headers: string[]): { mapping: ColumnMapping; matched: number } {
  const norm = headers.map(normalizeHeader);
  const used = new Set<number>();
  const mapping: ColumnMapping = {};
  let matched = 0;
  const assign = (field: BookingField, predicate: (h: string) => boolean) => {
    if (mapping[field] != null) return;
    const idx = norm.findIndex((h, i) => !used.has(i) && h !== '' && predicate(h));
    if (idx >= 0) {
      mapping[field] = idx;
      used.add(idx);
      matched += 1;
    }
  };
  for (const f of ASSIGN_ORDER) assign(f, (h) => WORDS[f].has(h) || WORDS[f].has(stripAl(h)));
  for (const f of ASSIGN_ORDER) {
    assign(f, (h) => [...WORDS[f]].some((w) => w.length >= 3 && (h.includes(w) || (h.length >= 4 && w.includes(h)))));
  }
  for (const f of BOOKING_FIELDS) if (mapping[f] == null) mapping[f] = null;
  return { mapping, matched };
}

// ---------------------------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------------------------

const MONTHS: Record<string, number> = {
  يناير: 1, jan: 1, january: 1, كانون: 1,
  فبراير: 2, feb: 2, february: 2, شباط: 2,
  مارس: 3, mar: 3, march: 3, اذار: 3,
  ابريل: 4, اپريل: 4, apr: 4, april: 4, نيسان: 4,
  مايو: 5, may: 5, ايار: 5,
  يونيو: 6, يونيه: 6, jun: 6, june: 6, حزيران: 6,
  يوليو: 7, يوليه: 7, jul: 7, july: 7, تموز: 7,
  اغسطس: 8, aug: 8, august: 8, اب: 8,
  سبتمبر: 9, sep: 9, sept: 9, september: 9, ايلول: 9,
  اكتوبر: 10, oct: 10, october: 10,
  نوفمبر: 11, nov: 11, november: 11,
  ديسمبر: 12, dec: 12, december: 12,
};

function validYmd(y: number, m: number, d: number): string | null {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

const isNumeric = (t: string) => /^-?\d+(\.\d+)?$/.test(t);

/** Excel's day counter (1900 system, with its famous leap-year bug) → a plain date. */
export function excelSerialToYmd(serial: number): string | null {
  if (!(serial >= 36526 && serial < 73051)) return null; // 2000-01-01 … 2099-12-31
  const ms = Date.UTC(1899, 11, 30) + Math.floor(serial) * 86_400_000;
  const d = new Date(ms);
  return validYmd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

export interface ParsedDate {
  ymd: string;
  /** Minutes after midnight, when the cell was a date-time (Excel stores both in one number). */
  minutes?: number;
}

export function parseDate(raw: string, now: Date = new Date()): ParsedDate | null {
  const text = asciiDigits(raw).trim();
  if (!text) return null;
  if (isNumeric(text)) {
    const n = Number(text);
    const ymd = excelSerialToYmd(n);
    if (!ymd) return null;
    const frac = n - Math.floor(n);
    return frac > 0.0001 ? { ymd, minutes: Math.round(frac * 1440) } : { ymd };
  }
  // 2026-10-05 / 2026/10/05 / 2026.10.05 (optionally followed by a time)
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s].*)?$/.exec(text);
  if (m) {
    const ymd = validYmd(+m[1], +m[2], +m[3]);
    return ymd ? { ymd } : null;
  }
  // 5/10/2026 or 5-10-26 — Egyptian sheets are day-first.
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})(?:[T\s].*)?$/.exec(text);
  if (m) {
    const year = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    let day = +m[1];
    let month = +m[2];
    // 10/25/2026 can only be month-first.
    if (month > 12 && day <= 12) [day, month] = [month, day];
    const ymd = validYmd(year, month, day);
    return ymd ? { ymd } : null;
  }
  // 5/10 (no year): the current year, day-first.
  m = /^(\d{1,2})[-/.](\d{1,2})$/.exec(text);
  if (m) {
    const ymd = validYmd(now.getUTCFullYear(), +m[2], +m[1]);
    return ymd ? { ymd } : null;
  }
  // 5 أكتوبر 2026 / Oct 5, 2026 / October 5
  const words = normalizeHeader(text).split(' ');
  const monthWord = words.find((w) => MONTHS[w] != null || MONTHS[stripAl(w)] != null);
  if (monthWord) {
    const month = MONTHS[monthWord] ?? MONTHS[stripAl(monthWord)];
    const nums = text.match(/\d+/g)?.map(Number) ?? [];
    const year = nums.find((n) => n >= 2000 && n <= 2100) ?? now.getUTCFullYear();
    const day = nums.find((n) => n >= 1 && n <= 31);
    if (day) {
      const ymd = validYmd(year, month, day);
      return ymd ? { ymd } : null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Times and durations
// ---------------------------------------------------------------------------------------------

export interface ParsedTime {
  minutes: number;
  /** An hour from 1 to 11 with no morning/evening marker: the caller decides which one it is. */
  ambiguous: boolean;
}

/** "18:30", "6:30 PM", "٦ م", "6.30 مساءً", "0.75" (Excel's fraction of a day). */
export function parseTime(raw: string): ParsedTime | null {
  const text = asciiDigits(raw).trim().toLowerCase();
  if (!text) return null;
  if (/^0?\.\d+$/.test(text) || /^0\.\d+$/.test(text)) {
    const mins = Math.round(Number(text) * 1440);
    return mins >= 0 && mins < 1440 ? { minutes: mins, ambiguous: false } : null;
  }
  // A date-time string: keep only the time after the date.
  const timePart = /(?:^|[T\s])(\d{1,2}[:.]\d{2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.|ص|م|صباحا|صباحاً|مساء|مساءً|مساءا)?)\s*$/.exec(text)?.[1] ?? text;
  const m = /^(\d{1,2})(?:[:.](\d{2}))?(?::\d{2})?\s*(am|pm|a\.m\.|p\.m\.|ص|م|صباحا|صباحاً|مساء|مساءً|مساءا|صباحًا|مساءً|ظهرا|ظهراً|عصرا|عصراً|ليلا|ليلاً)?$/.exec(timePart.replace(/\s+/g, ' ').trim());
  if (!m) return null;
  let hour = +m[1];
  const minute = m[2] ? +m[2] : 0;
  if (minute > 59 || hour > 24) return null;
  const marker = m[3];
  if (marker) {
    const pm = /^(pm|p\.m\.|م|مساء|مساءا|مساءً|ظهرا|ظهراً|عصرا|عصراً|ليلا|ليلاً)$/.test(marker);
    const am = !pm;
    if (hour > 12) return null;
    if (pm && hour < 12) hour += 12;
    if (am && hour === 12) hour = 0;
    return { minutes: hour * 60 + minute, ambiguous: false };
  }
  if (hour === 24) hour = 0;
  return { minutes: hour * 60 + minute, ambiguous: hour >= 1 && hour <= 11 };
}

/** Minutes. `unit` comes from the header ("المدة بالساعات" / "mins"); a bare small number is hours. */
export function parseDuration(raw: string, unit?: 'hours' | 'minutes'): number | null {
  const text = asciiDigits(raw).trim().toLowerCase();
  if (!text) return null;
  const words = normalizeHeader(text);
  if (/^نص ساعه$|^نصف ساعه$/.test(words)) return 30;
  if (/^ساعه ونص$|^ساعه ونصف$/.test(words)) return 90;
  if (/^ساعه$/.test(words)) return 60;
  if (/^ساعتين$|^ساعتان$/.test(words)) return 120;
  if (/^ساعتين ونص$/.test(words)) return 150;
  if (/^(\d+(?:\.\d+)?) ?(?:ساعات|ساعه|h|hr|hrs|hour|hours)$/.test(words)) {
    return Math.round(Number(/^(\d+(?:\.\d+)?)/.exec(words)![1]) * 60);
  }
  if (/^(\d+) ?(?:دقيقه|دقايق|دقائق|د|m|min|mins|minutes)$/.test(words)) {
    return Number(/^(\d+)/.exec(words)![1]);
  }
  const hm = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (hm) return +hm[1] * 60 + +hm[2];
  if (!isNumeric(text)) return null;
  const n = Number(text);
  if (n <= 0) return null;
  if (unit === 'minutes') return Math.round(n);
  if (unit === 'hours') return Math.round(n * 60);
  // Unit unknown: 1, 1.5, 2 are hours; 60, 90, 120 are minutes.
  return n <= 8 ? Math.round(n * 60) : Math.round(n);
}

/** How a duration header reads: "المدة (دقيقة)" → minutes, "عدد الساعات" → hours. */
export function durationUnitFromHeader(header: string): 'hours' | 'minutes' | undefined {
  const h = normalizeHeader(header);
  if (/دقيقه|دقايق|دقائق|min/.test(h)) return 'minutes';
  if (/ساع|hour|\bhrs?\b/.test(h)) return 'hours';
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Money, payment method, source
// ---------------------------------------------------------------------------------------------

/** "1,500 ج" / "١٥٠٠" / "300.50" → minor units (piastres). Null when it is not an amount. */
export function parseMoneyMinor(raw: string): number | null {
  let text = asciiDigits(raw).trim().toLowerCase();
  if (!text) return null;
  text = text.replace(/(جنيه|جنية|ج\.?م\.?|ج|egp|l\.?e\.?|le|pound|pounds)/g, '').replace(/\s+/g, '');
  // 1,500 or 1.500,50 → plain number
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(text)) text = text.replace(/,/g, '');
  else if (/^\d+,\d{1,2}$/.test(text)) text = text.replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  const n = Number(text);
  if (!Number.isFinite(n) || n > 10_000_000) return null;
  return Math.round(n * 100);
}

export type ImportMethod = 'cash' | 'instapay' | 'wallet' | 'card';

export function parsePaymentMethod(raw: string): ImportMethod | null {
  const t = normalizeHeader(raw);
  if (!t) return null;
  if (/انستا|insta|ipn/.test(t)) return 'instapay';
  // "فودافون كاش" is a mobile wallet, not cash in the drawer — so wallets are checked before "cash".
  if (/فودافون|vodafone|محفظ|wallet|اورنج|orange|اتصالات|etisalat|we pay|ويفي|فوري|fawry/.test(t)) return 'wallet';
  if (/كارت|كرت|فيزا|visa|card|ماستر|master|بطاق/.test(t)) return 'card';
  if (/كاش|نقد|cash|عدي/.test(t)) return 'cash';
  return null;
}

export type ImportSourceKey = 'walk_in' | 'phone' | 'whatsapp' | 'other_platform';

/** A recognised channel becomes its preset; anything else is kept as the owner's own label. */
export function parseSource(raw: string): { key?: ImportSourceKey; label?: string } {
  const t = normalizeHeader(raw);
  if (!t) return {};
  if (/واتس|whats|wa$/.test(t)) return { key: 'whatsapp' };
  if (/تليفون|تلفون|اتصال|مكالم|phone|call|موبايل/.test(t)) return { key: 'phone' };
  if (/بنفسه|walk|حضور|مباشر|في المكان|جاي|direct/.test(t)) return { key: 'walk_in' };
  if (/منصه|app|facebook|فيس|instagram|انستجرام/.test(t)) return { key: 'other_platform' };
  return { label: raw.normalize('NFKC').trim().replace(/\s+/g, ' ').slice(0, 60) };
}

const COURT_WORDS = new Set(['ملعب', 'court', 'pitch', 'field', 'ترابيزه', 'طاوله', 'table', 'ستاد', 'استاد']);

/** Court names compare without "ملعب"/"Court", "ال", spacing, case or Arabic spelling variants. */
export function courtKey(name: string): string {
  const words = normalizeHeader(name).split(' ').filter(Boolean);
  const core = words.map(stripAl).filter((w) => w && !COURT_WORDS.has(w)).join('');
  return core || words.join('');
}
