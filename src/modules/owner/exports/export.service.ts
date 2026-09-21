import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { LedgerService } from '../../finance/ledger.service';
import { ExpensesService } from '../expenses/expenses.service';
import { OwnerSummaryService, localDateTime } from '../owner-summary.service';
import { assertVenueAccess } from '../../../common/access/owner-access';
import { loadStaffScope, scopeCan } from '../../../common/access/staff-scope';
import type { PermissionKey } from '../../../common/access/permissions';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.interface';
import { addDays, isLocalDate } from '../../../common/utils/fixed-series.util';
import { resolveOwnerRange } from '../../../common/utils/owner-range.util';
import { sourceDisplay } from '../../../common/utils/source-label.util';
import { buildCsvZip, buildXlsx, type ExportSheet } from '../../../common/utils/tabular-export.util';

export type ExportLang = 'ar' | 'en';
export type ExportFormat = 'xlsx' | 'csv';

/** The longest period one export may cover — keeps a single request cheap. */
export const MAX_EXPORT_DAYS = 366;
const MAX_BOOKING_ROWS = 20_000;

const T = {
  summary: ['ملخص', 'Summary'],
  bookings: ['الحجوزات', 'Bookings'],
  daily: ['يومي', 'Daily'],
  byCourt: ['حسب الملعب', 'By court'],
  bySource: ['حسب المصدر', 'By source'],
  customers: ['أفضل العملاء', 'Top customers'],
  expenses: ['المصروفات', 'Expenses'],
  account: ['الحساب مع ماتشنا', 'Matchena account'],
  discounts: ['الخصومات', 'Discounts'],
  metric: ['البند', 'Item'],
  value: ['القيمة', 'Value'],
  period: ['الفترة', 'Period'],
  currency: ['العملة', 'Currency'],
  bookingsCount: ['عدد الحجوزات', 'Bookings'],
  collected: ['الإيراد المحصّل', 'Collected revenue'],
  fromMatchena: ['من حجوزات ماتشنا', 'From Matchena bookings'],
  ownRevenue: ['من حجوزاتك', 'From your own bookings'],
  commission: ['عمولة ماتشنا', 'Matchena commission'],
  takeHome: ['الصافي بعد العمولة', 'Take-home after commission'],
  expensesTotal: ['المصروفات', 'Expenses'],
  netProfit: ['الربح الفعلي', 'Real profit'],
  outstanding: ['المتبقي غير المحصّل', 'Outstanding'],
  cash: ['محصّل كاش', 'Collected as cash'],
  online: ['محصّل أونلاين', 'Collected online'],
  code: ['الكود', 'Code'],
  source: ['المصدر', 'Source'],
  court: ['الملعب', 'Court'],
  date: ['التاريخ', 'Date'],
  time: ['الساعة', 'Time'],
  minutes: ['المدة (دقيقة)', 'Duration (min)'],
  status: ['الحالة', 'Status'],
  customer: ['العميل', 'Customer'],
  price: ['السعر', 'Price'],
  paid: ['المدفوع', 'Paid'],
  remaining: ['المتبقي', 'Remaining'],
  method: ['طريقة الدفع', 'Payment method'],
  net: ['الصافي', 'Net'],
  revenue: ['الإيراد', 'Revenue'],
  occupied: ['دقائق مشغولة', 'Occupied minutes'],
  occupancy: ['الإشغال %', 'Occupancy %'],
  spent: ['المدفوع منه', 'Spent'],
  category: ['الفئة', 'Category'],
  note: ['ملاحظة', 'Note'],
  monthly: ['شهري', 'Monthly'],
  amount: ['المبلغ', 'Amount'],
  kind: ['النوع', 'Type'],
  balance: ['الرصيد', 'Balance'],
  balanceHint: ['موجب = ماتشنا مدينة لك، سالب = أنت مدين لماتشنا', 'Positive = Matchena owes you, negative = you owe Matchena'],
  weekday: ['اليوم', 'Weekday'],
  hours: ['الساعات', 'Hours'],
  percent: ['نسبة الخصم %', 'Discount %'],
  from: ['من', 'From'],
  until: ['إلى', 'Until'],
  baseline: ['الإشغال قبل الخصم %', 'Occupancy before %'],
  yes: ['نعم', 'Yes'],
} as const;

const WEEKDAYS: [string, string][] = [
  ['الأحد', 'Sunday'], ['الاثنين', 'Monday'], ['الثلاثاء', 'Tuesday'], ['الأربعاء', 'Wednesday'],
  ['الخميس', 'Thursday'], ['الجمعة', 'Friday'], ['السبت', 'Saturday'],
];

const major = (minor: number) => Math.round(minor) / 100;

/**
 * "Export centre": every figure an accountant asks for, for any period, in one workbook.
 * Every number comes from the same services as the screens (summary, expenses, ledger), so
 * the file and the app cannot disagree.
 */
@Injectable()
export class ExportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly summary: OwnerSummaryService,
    private readonly expenses: ExpensesService,
    private readonly ledger: LedgerService,
  ) {}

  async build(user: AuthenticatedUser, q: { venueId: string; from: string; to: string; lang?: string; format?: string }) {
    const lang: ExportLang = q.lang === 'en' ? 'en' : 'ar';
    const format: ExportFormat = q.format === 'csv' ? 'csv' : 'xlsx';
    if (!isLocalDate(q.from) || !isLocalDate(q.to) || q.to < q.from) {
      throw new BadRequestException('from/to must be valid dates, from <= to');
    }
    if (q.to > addDays(q.from, MAX_EXPORT_DAYS - 1)) {
      throw new BadRequestException(`An export can cover ${MAX_EXPORT_DAYS} days at most`);
    }
    const venue = await assertVenueAccess(this.prisma, user, q.venueId, { write: false });
    const sheets = await this.sheets(user, venue.id, q.from, q.to, lang);
    await this.prisma.auditLogEntry.create({
      data: {
        actorUserId: user.id,
        action: 'report.exported',
        targetType: 'venue',
        targetId: venue.id,
        metadata: { from: q.from, to: q.to, format, sheets: sheets.length },
      },
    });
    const file =
      format === 'csv' ? buildCsvZip(sheets) : buildXlsx(sheets, { rtl: lang === 'ar' });
    return {
      file,
      format,
      filename: `matchena-${q.from}_${q.to}.${format === 'csv' ? 'zip' : 'xlsx'}`,
      contentType:
        format === 'csv'
          ? 'application/zip'
          : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    };
  }

  /** The workbook as data — also what the tests compare against the on-screen summary. */
  async sheets(user: AuthenticatedUser, venueId: string, from: string, to: string, lang: ExportLang): Promise<ExportSheet[]> {
    const i = lang === 'ar' ? 0 : 1;
    const t = (k: keyof typeof T) => T[k][i];
    const s = await this.summary.getSummary(user, venueId, 'custom', from, to);
    const tz = s.range.timezone;
    const range = resolveOwnerRange('custom', tz, from, to);
    const totals = s.totals as typeof s.totals & { expenses?: number; netProfit?: number };

    const summarySheet: ExportSheet = {
      name: t('summary'),
      columns: [{ header: t('metric'), width: 34 }, { header: t('value'), width: 24 }],
      rows: [
        [t('period'), `${from} → ${to}`],
        [t('currency'), s.currency],
        [t('bookingsCount'), totals.bookings],
        [t('collected'), major(totals.collectedRevenue)],
        [t('fromMatchena'), major(totals.matchenaRevenue)],
        [t('ownRevenue'), major(totals.ownRevenue)],
        [t('commission'), major(totals.commission)],
        [t('takeHome'), major(totals.takeHome)],
        [t('expensesTotal'), major(totals.expenses ?? 0)],
        [t('netProfit'), major(totals.netProfit ?? totals.takeHome)],
        [t('outstanding'), major(totals.outstanding)],
        [t('cash'), major(totals.cashCollected)],
        [t('online'), major(totals.onlineCollected)],
      ],
    };

    const bookingRows = await this.prisma.booking.findMany({
      where: { venueId, slotStart: { gte: range.start, lt: range.end }, status: { not: 'cancelled' } },
      include: {
        court: { select: { name: true } },
        user: { select: { name: true } },
        payments: { where: { status: 'paid' }, select: { amount: true } },
      },
      orderBy: { slotStart: 'asc' },
      take: MAX_BOOKING_ROWS,
    });
    const bookingsSheet: ExportSheet = {
      name: t('bookings'),
      columns: [
        { header: t('code'), width: 16 }, { header: t('source'), width: 18 }, { header: t('court'), width: 18 },
        { header: t('date'), width: 12 }, { header: t('time'), width: 8 }, { header: t('minutes'), width: 12 },
        { header: t('status'), width: 12 }, { header: t('customer'), width: 22 }, { header: t('price'), width: 12 },
        { header: t('paid'), width: 12 }, { header: t('remaining'), width: 12 }, { header: t('method'), width: 12 },
        { header: t('commission'), width: 12 }, { header: t('net'), width: 12 },
      ],
      rows: bookingRows.map((b) => {
        const platform = b.source === 'platform';
        const local = localDateTime(b.slotStart, tz);
        // What the owner is owed for the slot — never the player-paid total, which includes the service fee.
        const price = platform ? Math.max(0, b.baseAmount - (b.ownerFundedDiscount ?? 0)) : b.totalAmount;
        const commission = platform ? (b.commissionAmount ?? 0) : 0;
        const paid = b.payments.reduce((sum, p) => sum + p.amount, 0);
        return [
          b.code,
          sourceDisplay(b.source, b.sourceKey, b.sourceLabel).label,
          b.court.name,
          local.date,
          local.time,
          Math.round((b.slotEnd.getTime() - b.slotStart.getTime()) / 60_000),
          b.status,
          b.guestName ?? b.user.name,
          major(price),
          platform ? null : major(paid),
          platform ? null : major(Math.max(0, b.totalAmount - paid)),
          b.paymentMethod ?? '',
          major(commission),
          major(platform ? (b.ownerNetAmount ?? price - commission) : price),
        ];
      }),
    };

    const sheets: ExportSheet[] = [
      summarySheet,
      bookingsSheet,
      {
        name: t('daily'),
        columns: [{ header: t('date'), width: 14 }, { header: t('bookingsCount'), width: 12 }, { header: t('revenue'), width: 14 }],
        rows: s.byDay.map((d) => [d.date, d.bookings, major(d.revenue)]),
      },
      {
        name: t('byCourt'),
        columns: [
          { header: t('court'), width: 22 }, { header: t('bookingsCount'), width: 12 }, { header: t('revenue'), width: 14 },
          { header: t('occupied'), width: 16 }, { header: t('occupancy'), width: 12 },
        ],
        rows: s.byUnit.map((u) => [u.name, u.bookings, major(u.revenue), u.occupiedMinutes, u.occupancyPct]),
      },
      {
        name: t('bySource'),
        columns: [{ header: t('source'), width: 22 }, { header: t('bookingsCount'), width: 12 }, { header: t('revenue'), width: 14 }],
        rows: s.bySource.map((r) => [r.label, r.bookings, major(r.revenue)]),
      },
      {
        // No phone numbers here on purpose: those are a `customers.view` matter.
        name: t('customers'),
        columns: [{ header: t('customer'), width: 26 }, { header: t('bookingsCount'), width: 12 }, { header: t('spent'), width: 14 }],
        rows: s.topCustomers.map((c) => [c.name ?? '', c.bookings, major(c.spent)]),
      },
    ];

    const expenseRows = await this.prisma.venueExpense.findMany({
      where: { venueId, incurredOn: { gte: from, lte: to } },
      orderBy: { incurredOn: 'asc' },
    });
    sheets.push({
      name: t('expenses'),
      columns: [
        { header: t('date'), width: 12 }, { header: t('category'), width: 18 }, { header: t('note'), width: 30 },
        { header: t('amount'), width: 14 }, { header: t('monthly'), width: 10 },
      ],
      rows: expenseRows.map((e) => [
        e.incurredOn,
        e.category === 'other' && e.categoryLabel ? e.categoryLabel : e.category,
        e.note ?? '',
        major(e.amount),
        e.recurringMonthly || e.recurringParentId ? t('yes') : '',
      ]),
    });

    if (await this.can(user, 'account.view')) {
      const balance = await this.ledger.getBalance(venueId, s.currency);
      const entries = await this.ledger.listEntries(venueId, { limit: 500 });
      const inRange = entries.items.filter((e) => e.createdAt >= range.start && e.createdAt < range.end);
      sheets.push({
        name: t('account'),
        columns: [{ header: t('date'), width: 12 }, { header: t('kind'), width: 22 }, { header: t('amount'), width: 14 }, { header: t('note'), width: 40 }],
        rows: [
          [t('balance'), '', major(balance), t('balanceHint')],
          ...inRange.map((e) => [localDateTime(e.createdAt, tz).date, String(e.kind), major(e.amount), (e.reason ?? e.booking?.code ?? '')]),
        ],
      });
    }

    const discounts = await this.prisma.pricingDiscount.findMany({
      where: { venueId, status: { in: ['active', 'ended'] }, createdAt: { lt: range.end } },
      include: { court: { select: { name: true } } },
      orderBy: { createdAt: 'asc' },
    });
    sheets.push({
      name: t('discounts'),
      columns: [
        { header: t('court'), width: 18 }, { header: t('weekday'), width: 12 }, { header: t('hours'), width: 12 },
        { header: t('percent'), width: 14 }, { header: t('from'), width: 12 }, { header: t('until'), width: 12 },
        { header: t('status'), width: 10 }, { header: t('baseline'), width: 18 },
      ],
      rows: discounts.map((d) => [
        d.court.name,
        WEEKDAYS[d.weekday]?.[i] ?? String(d.weekday),
        `${String(d.startHour).padStart(2, '0')}:00–${String(d.endHour).padStart(2, '0')}:00`,
        d.percent,
        d.validFrom ? localDateTime(d.validFrom, tz).date : '',
        d.validUntil ? localDateTime(d.validUntil, tz).date : '',
        d.status,
        d.baselineOccupancy != null ? Math.round(d.baselineOccupancy * 100) : null,
      ]),
    });

    return sheets;
  }

  private async can(user: AuthenticatedUser, key: PermissionKey): Promise<boolean> {
    if (!user.roles.includes('staff') || user.roles.includes('admin') || user.roles.includes('owner')) return true;
    return scopeCan(await loadStaffScope(this.prisma, user.id), key);
  }
}
