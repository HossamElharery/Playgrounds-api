import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { assertVenueAccess } from '../../../common/access/owner-access';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.interface';
import { PrismaService } from '../../prisma/prisma.service';
import { bi, type Bi } from '../assistant/assistant.types';
import { fmtMoney } from '../assistant/assistant-money';

/** The decisions an owner wants to be able to look back on: who booked, changed a price, took or returned money, took a drawer over. */
export const ACTIVITY_ACTIONS = [
  'owner.booking.created',
  'owner.booking.updated',
  'owner.booking.cancelled',
  'owner.booking.restored',
  'owner.booking.payment_recorded',
  'owner.booking.payment_voided',
  'owner.booking.change_requested',
  'owner.shift.opened',
  'owner.shift.closed',
  'owner.shift.reviewed',
  'owner.expense.recorded',
  'owner.import.committed',
  'owner.import.undone',
  'pricing.discount.applied',
  'pricing.discount.ended',
] as const;

export type ActivityKind = 'booking' | 'money' | 'cash' | 'price' | 'data';

export interface ActivityItem {
  id: string;
  at: string;
  kind: ActivityKind;
  actorName: string | null;
  /** One sentence, in plain words, naming who did what. */
  text: Bi;
  bookingId: string | null;
}

const PAGE = 40;

type Meta = Record<string, unknown>;
const num = (v: unknown) => (typeof v === 'number' ? v : 0);

/** The words for each expense category, so the trail never shows a raw key like "electricity". */
const EXPENSE_WORDS: Record<string, Bi> = {
  electricity: bi('كهرباء', 'electricity'),
  water: bi('مياه', 'water'),
  rent: bi('إيجار', 'rent'),
  salaries: bi('رواتب', 'salaries'),
  maintenance: bi('صيانة', 'maintenance'),
  marketing: bi('تسويق', 'marketing'),
  supplies: bi('مشتريات', 'supplies'),
  purchases: bi('مشتريات', 'purchases'),
  other: bi('أخرى', 'other'),
};
const str = (v: unknown) => (typeof v === 'string' && v ? v : null);

/** Reads each field of `changed` ({ field: [before, after] }) as a short bilingual phrase. Pure. */
export function describeChanges(changed: Record<string, [unknown, unknown]> | undefined, currency: string): Bi[] {
  const out: Bi[] = [];
  for (const [field, pair] of Object.entries(changed ?? {})) {
    const [from, to] = pair ?? [];
    if (field === 'priceAmount') {
      out.push(bi(`السعر من ${fmtMoney(num(from), currency).ar} إلى ${fmtMoney(num(to), currency).ar}`, `price from ${fmtMoney(num(from), currency).en} to ${fmtMoney(num(to), currency).en}`));
    } else if (field === 'slotStart') {
      out.push(bi('الميعاد', 'the time'));
    } else if (field === 'courtId') {
      out.push(bi('الوحدة', 'the unit'));
    } else if (field === 'guestName' || field === 'guestPhone') {
      out.push(bi('بيانات العميل', 'the customer details'));
    } else if (field === 'paymentMethod') {
      out.push(bi('طريقة الدفع', 'the payment method'));
    } else if (field === 'notes') {
      out.push(bi('الملاحظات', 'the notes'));
    } else {
      out.push(bi('بيانات الحجز', 'the booking'));
    }
  }
  return out;
}

/** Turns one audit row into a sentence an owner can read. Pure — the tests pin every wording. */
export function describeActivity(
  action: string,
  m: Meta,
  currency: string,
): { kind: ActivityKind; text: (who: Bi) => Bi } {
  const code = str(m.code);
  const money = (minor: unknown) => fmtMoney(num(minor), str(m.currency) ?? currency);
  const ref = (ar: string, en: string) => ({ ar: code ? `${ar} ${code}` : ar, en: code ? `${en} ${code}` : en });
  switch (action) {
    case 'owner.booking.created': {
      const cust = str(m.customer);
      return {
        kind: 'booking',
        text: (who) =>
          bi(
            `${who.ar} سجّل حجز${cust ? ` لـ ${cust}` : ''} بـ ${money(m.amount).ar}${code ? ` (${code})` : ''}${num(m.paid) > 0 ? ` وقبض ${money(m.paid).ar}` : ''}`,
            `${who.en} booked${cust ? ` for ${cust}` : ''} at ${money(m.amount).en}${code ? ` (${code})` : ''}${num(m.paid) > 0 ? ` and took ${money(m.paid).en}` : ''}`,
          ),
      };
    }
    case 'owner.booking.updated': {
      const parts = describeChanges(m.changed as Record<string, [unknown, unknown]> | undefined, str(m.currency) ?? currency);
      const priceChanged = !!(m.changed as Record<string, unknown> | undefined)?.priceAmount;
      return {
        kind: priceChanged ? 'price' : 'booking',
        text: (who) =>
          bi(
            `${who.ar} عدّل ${parts.map((p) => p.ar).join('، ') || 'الحجز'}`,
            `${who.en} changed ${parts.map((p) => p.en).join(', ') || 'the booking'}`,
          ),
      };
    }
    case 'owner.booking.cancelled': {
      const r = ref('حجز', 'booking');
      const gave = num(m.refunded);
      const kept = num(m.kept);
      const arMoney = gave > 0 ? ` ورجّع ${money(gave).ar}` : '';
      const enMoney = gave > 0 ? ` and handed back ${money(gave).en}` : '';
      const arKept = kept > 0 ? `${gave > 0 ? '، و' : ' و'}احتفظ بـ ${money(kept).ar}` : '';
      const enKept = kept > 0 ? `${gave > 0 ? ', ' : ' and '}kept ${money(kept).en}` : '';
      return {
        kind: 'booking',
        text: (who) => bi(`${who.ar} لغى ${r.ar}${arMoney}${arKept}`, `${who.en} cancelled ${r.en}${enMoney}${enKept}`),
      };
    }
    case 'owner.booking.restored': {
      const r = ref('حجز', 'booking');
      return { kind: 'booking', text: (who) => bi(`${who.ar} رجّع ${r.ar}`, `${who.en} restored ${r.en}`) };
    }
    case 'owner.booking.payment_recorded':
      return {
        kind: 'money',
        text: (who) =>
          bi(
            `${who.ar} قبض ${money(m.amount).ar}${num(m.remaining) > 0 ? ` (باقي ${money(m.remaining).ar})` : ''}`,
            `${who.en} took ${money(m.amount).en}${num(m.remaining) > 0 ? ` (${money(m.remaining).en} left)` : ''}`,
          ),
      };
    case 'owner.booking.payment_voided': {
      const reason = str(m.reason);
      return {
        kind: 'money',
        text: (who) =>
          bi(
            `${who.ar} رجّع ${money(m.amount).ar}${reason ? ` — ${reason}` : ''}`,
            `${who.en} refunded ${money(m.amount).en}${reason ? ` — ${reason}` : ''}`,
          ),
      };
    }
    case 'owner.booking.change_requested':
      return {
        kind: 'booking',
        text: (who) =>
          bi(
            `${who.ar} طلب ${m.kind === 'cancel' ? 'إلغاء' : 'تعديل'} حجز ماتشنا`,
            `${who.en} asked to ${m.kind === 'cancel' ? 'cancel' : 'change'} a Matchena booking`,
          ),
      };
    case 'owner.shift.opened': {
      const diff = num(m.difference);
      return {
        kind: 'cash',
        text: (who) =>
          bi(
            `${who.ar} استلم الخزنة وعدّ ${money(m.countedFloat).ar}${diff ? ` (${diff < 0 ? 'أقل' : 'أكتر'} من اللي سابوه بـ ${money(Math.abs(diff)).ar})` : ''}`,
            `${who.en} took the drawer over, counting ${money(m.countedFloat).en}${diff ? ` (${money(Math.abs(diff)).en} ${diff < 0 ? 'less' : 'more'} than left)` : ''}`,
          ),
      };
    }
    case 'owner.shift.closed': {
      const diff = num(m.difference);
      return {
        kind: 'cash',
        text: (who) =>
          bi(
            `${who.ar} قفل الخزنة: ${diff === 0 ? 'مظبوطة' : `${diff < 0 ? 'ناقصة' : 'زيادة'} ${money(Math.abs(diff)).ar}`}`,
            `${who.en} closed the drawer: ${diff === 0 ? 'it balanced' : `${money(Math.abs(diff)).en} ${diff < 0 ? 'short' : 'over'}`}`,
          ),
      };
    }
    case 'owner.shift.reviewed':
      return { kind: 'cash', text: (who) => bi(`${who.ar} راجع وردية`, `${who.en} reviewed a shift`) };
    case 'owner.expense.recorded': {
      const key = str(m.category) ?? '';
      const words = EXPENSE_WORDS[key];
      const custom = str(m.categoryLabel);
      const label: Bi = custom ? bi(custom, custom) : words ?? bi(key, key);
      return {
        kind: 'money',
        text: (who) =>
          bi(
            `${who.ar} سجّل مصروف ${label.ar} ${money(m.amount).ar}${m.fromDrawer ? ' من الخزنة' : ''}`.replace('  ', ' '),
            `${who.en} recorded an expense ${label.en} ${money(m.amount).en}${m.fromDrawer ? ' from the drawer' : ''}`.replace('  ', ' '),
          ),
      };
    }
    case 'owner.import.committed':
      return { kind: 'data', text: (who) => bi(`${who.ar} استورد ${num(m.created)} صف`, `${who.en} imported ${num(m.created)} rows`) };
    case 'owner.import.undone':
      return { kind: 'data', text: (who) => bi(`${who.ar} مسح استيراد (${num(m.removed)} صف)`, `${who.en} undid an import (${num(m.removed)} rows)`) };
    case 'pricing.discount.applied':
      return { kind: 'price', text: (who) => bi(`${who.ar} فعّل خصم`, `${who.en} started a discount`) };
    case 'pricing.discount.ended':
      return { kind: 'price', text: (who) => bi(`${who.ar} وقّف خصم`, `${who.en} ended a discount`) };
    default:
      return { kind: 'data', text: (who) => bi(`${who.ar} عمل تغيير`, `${who.en} made a change`) };
  }
}

@Injectable()
export class ActivityService {
  constructor(private readonly prisma: PrismaService) {}

  async list(user: AuthenticatedUser, venueId: string, cursor?: string) {
    const venue = await assertVenueAccess(this.prisma, user, venueId, { write: false });
    const where: Prisma.AuditLogEntryWhereInput = {
      action: { in: [...ACTIVITY_ACTIONS] },
      OR: [{ metadata: { path: ['venueId'], equals: venueId } }, { targetType: 'venue', targetId: venueId }],
    };
    const rows = await this.prisma.auditLogEntry.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: PAGE + 1,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    const hasMore = rows.length > PAGE;
    const page = hasMore ? rows.slice(0, PAGE) : rows;
    const actors = await this.prisma.user.findMany({
      where: { id: { in: [...new Set(page.map((r) => r.actorUserId))] } },
      select: { id: true, name: true },
    });
    const names = new Map(actors.map((a) => [a.id, a.name]));
    const items: ActivityItem[] = page.map((r) => {
      const meta = (r.metadata ?? {}) as Meta;
      const d = describeActivity(r.action, meta, venue.currency);
      const name = names.get(r.actorUserId) ?? null;
      return {
        id: r.id,
        at: r.createdAt.toISOString(),
        kind: d.kind,
        actorName: name,
        text: d.text(bi(name ?? 'حد', name ?? 'Someone')),
        bookingId: str(meta.bookingId),
      };
    });
    return { items, nextCursor: hasMore ? page[page.length - 1].id : undefined };
  }
}
