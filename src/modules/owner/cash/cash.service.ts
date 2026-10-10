import { isoMoneyScale,legacyMoney,rescaleMoney } from '../../../common/money/money-scale';
import { ConflictException, ForbiddenException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { CashHandover, CashShift, Prisma } from '@prisma/client';
import { assertVenueAccess } from '../../../common/access/owner-access';
import { loadStaffScope, scopeCan } from '../../../common/access/staff-scope';
import { ApiException } from '../../../common/errors/api-exception';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.interface';
import { resolveOwnerRange } from '../../../common/utils/owner-range.util';
import { NotificationsService } from '../../notifications/notifications.service';
import { PrismaService } from '../../prisma/prisma.service';
import { moneyText } from '../../../common/money/money-text';
import { CloseShiftDto, OpenShiftDto, ShiftListQueryDto } from './cash.dto';
import { COUNTED_PAYMENT_STATUSES } from './payment-trail';

type Db = PrismaService | Prisma.TransactionClient;

export interface MethodTally {
  method: string;
  /** Money received by this method (positive rows). */
  in: number;
  /** Money handed back by this method (refund rows, as a positive number). */
  out: number;
  count: number;
}

export interface Tally {
  paymentIds: string[];
  expenseIds: string[];
  byMethod: MethodTally[];
  cashIn: number;
  cashRefunds: number;
  cashExpenses: number;
  /** Cash that should be in the drawer from these movements alone (without any starting float). */
  cashNet: number;
  count: number;
  since: Date | null;
}

interface PaymentRow {
  id: string;
  amount: number;
  moneyScale?:number;
  currency: string;
  method: string;
  createdAt: Date;
  recordedByUserId: string | null;
}
interface ExpenseRow {
  id: string;
  amount: number;
  currency: string;
  createdAt: Date;
  createdById: string | null;
}

/** Rows whose currency is not the venue's — a drawer mixing currencies cannot be counted. Pure. */
export function foreignCurrencyRows(currency: string, ...groups: Array<Array<{ id: string; currency: string }>>) {
  return groups.flat().filter((r) => r.currency !== currency);
}

/** Adds the movements up: per method, plus the cash arithmetic the shift close is built on. Pure. */
export function tally(payments: PaymentRow[], expenses: ExpenseRow[]): Tally {
  const methods = new Map<string, MethodTally>();
  let cashIn = 0;
  let cashRefunds = 0;
  let since: Date | null = null;
  const touch = (d: Date) => {
    if (!since || d < since) since = d;
  };
  for (const row of payments) {
    const p={...row,amount:legacyMoney(row)};
    const m = methods.get(p.method) ?? { method: p.method, in: 0, out: 0, count: 0 };
    if (p.amount >= 0) {
      m.in += p.amount;
      m.count += 1;
      if (p.method === 'cash') cashIn += p.amount;
    } else {
      m.out += -p.amount;
      if (p.method === 'cash') cashRefunds += -p.amount;
    }
    methods.set(p.method, m);
    touch(p.createdAt);
  }
  let cashExpenses = 0;
  for (const e of expenses) {
    cashExpenses += e.amount;
    touch(e.createdAt);
  }
  return {
    paymentIds: payments.map((p) => p.id),
    expenseIds: expenses.map((e) => e.id),
    byMethod: [...methods.values()].sort((a, b) => b.in - b.out - (a.in - a.out)),
    cashIn,
    cashRefunds,
    cashExpenses,
    cashNet: cashIn - cashRefunds - cashExpenses,
    count: payments.length + expenses.length,
    since,
  };
}

/** What the drawer should hold, and how far the hand count is from it (negative = short). Pure. */
export function reconcile(input: { openingFloat: number; cashNet: number; countedCash: number }) {
  const expectedCash = input.openingFloat + input.cashNet;
  return { expectedCash, difference: input.countedCash - expectedCash };
}

const SHIFT_LIST_LIMIT = 30;

@Injectable()
export class CashService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications?: NotificationsService,
  ) {}

  // ---- who may do what ----------------------------------------------------------------------

  private async canReview(user: AuthenticatedUser): Promise<boolean> {
    if (user.roles.includes('admin') || user.roles.includes('owner')) return true;
    return scopeCan(await loadStaffScope(this.prisma, user.id), 'shifts.review');
  }

  // ---- reading the open drawers ---------------------------------------------------------------

  private async movements(db: Db, venueId: string, userIds: string[] | null) {
    const [payments, expenses] = await Promise.all([
      db.payment.findMany({
        where: {
          shiftId: null,
          status: { in: COUNTED_PAYMENT_STATUSES },
          recordedByUserId: userIds ? { in: userIds } : { not: null },
          OR: [{ booking: { venueId } }, { gamingOrder: { venueId } }],
        },
        select: { id: true, amount: true, moneyScale:true,currency: true, method: true, createdAt: true, recordedByUserId: true },
        orderBy: { createdAt: 'asc' },
      }),
      db.venueExpense.findMany({
        where: {
          venueId,
          fromDrawer: true,
          shiftId: null,
          ...(userIds ? { createdById: { in: userIds } } : {}),
        },
        select: { id: true, amount: true, currency: true, createdAt: true, createdById: true },
        orderBy: { createdAt: 'asc' },
      }),
    ]);
    return { payments: payments as PaymentRow[], expenses: expenses as ExpenseRow[] };
  }

  /** Cash the previous close of THIS drawer left behind for the next shift. */
  private async suggestedFloat(db: Db, venueId: string, drawerUserId: string | null): Promise<{ float: number; lastClosedAt: Date | null }> {
    const last = await db.cashShift.findFirst({
      where: { venueId, drawerUserId },
      orderBy: { closedAt: 'desc' },
      select: { carryOver: true,moneyScale:true, closedAt: true },
    });
    return { float: last?rescaleMoney(last.carryOver,last.moneyScale??100,100):0, lastClosedAt: last?.closedAt ?? null };
  }

  private toTallyDto(t: Tally, float: number) {
    return {
      count: t.count,
      since: t.since?.toISOString() ?? null,
      byMethod: t.byMethod,
      cash: {
        in: t.cashIn,
        refunds: t.cashRefunds,
        expenses: t.cashExpenses,
        net: t.cashNet,
        openingFloat: float,
        expected: float + t.cashNet,
      },
    };
  }

  /**
   * Everything the cash screen needs in one read: my open drawer, and — for the owner and anyone
   * with `shifts.review` — every colleague's open drawer plus a single shared drawer over all of it.
   */
  async drawer(user: AuthenticatedUser, venueId: string) {
    const venue = await assertVenueAccess(this.prisma, user, venueId, { write: false });
    const reviewer = await this.canReview(user);
    const currency = venue.currency;

    const mine = await this.movements(this.prisma, venueId, [user.id]);
    const myFloat = await this.suggestedFloat(this.prisma, venueId, user.id);
    const myHandover = await this.openHandover(this.prisma, venueId, user.id);
    const result: Record<string, unknown> = {
      venueId,
      currency,
      me: { userId: user.id, name: user.name ?? null },
      canReview: reviewer,
      mine: {
        ...this.toTallyDto(tally(mine.payments, mine.expenses), myHandover?rescaleMoney(myHandover.countedFloat,myHandover.moneyScale??100,100):myFloat.float),
        lastClosedAt: myFloat.lastClosedAt?.toISOString() ?? null,
        /** What the last close left — the number a taking-over count is compared with. */
        suggestedFloat: myFloat.float,
        handover: myHandover ? this.handoverDto(myHandover, new Map([[user.id, user.name ?? null]])) : null,
      },
      people: [] as unknown[],
      shared: null as unknown,
      mixedCurrencyCount: 0,
    };

    const everything = reviewer ? await this.movements(this.prisma, venueId, null) : mine;
    result.mixedCurrencyCount = foreignCurrencyRows(currency, everything.payments, everything.expenses).length;

    if (reviewer) {
      const all = everything;
      const byPerson = new Map<string, { payments: PaymentRow[]; expenses: ExpenseRow[] }>();
      const slot = (id: string) => byPerson.get(id) ?? byPerson.set(id, { payments: [], expenses: [] }).get(id)!;
      for (const p of all.payments) if (p.recordedByUserId) slot(p.recordedByUserId).payments.push(p);
      for (const e of all.expenses) if (e.createdById) slot(e.createdById).expenses.push(e);
      const ids = [...byPerson.keys()];
      const names = await this.names(ids);
      const people: Array<{ userId: string; name: string | null; isMe: boolean; handover: ReturnType<CashService['handoverDto']> | null } & ReturnType<CashService['toTallyDto']>> = [];
      for (const id of ids) {
        const bucket = byPerson.get(id)!;
        const f = await this.suggestedFloat(this.prisma, venueId, id);
        const h = await this.openHandover(this.prisma, venueId, id);
        people.push({
          userId: id,
          name: names.get(id) ?? null,
          isMe: id === user.id,
          ...this.toTallyDto(tally(bucket.payments, bucket.expenses), h?rescaleMoney(h.countedFloat,h.moneyScale??100,100):f.float),
          handover: h ? this.handoverDto(h, new Map([[h.openedByUserId, names.get(h.openedByUserId) ?? null]])) : null,
        });
      }
      people.sort((a, b) => b.cash.net - a.cash.net);
      result.people = people;
      const sharedFloat = await this.suggestedFloat(this.prisma, venueId, null);
      const sharedHandover = await this.openHandover(this.prisma, venueId, null);
      result.shared = {
        ...this.toTallyDto(tally(all.payments, all.expenses), sharedHandover?rescaleMoney(sharedHandover.countedFloat,sharedHandover.moneyScale??100,100):sharedFloat.float),
        lastClosedAt: sharedFloat.lastClosedAt?.toISOString() ?? null,
        suggestedFloat: sharedFloat.float,
        handover: sharedHandover
          ? this.handoverDto(sharedHandover, new Map([[sharedHandover.openedByUserId, names.get(sharedHandover.openedByUserId) ?? null]]))
          : null,
      };
    }

    result.recent = (await this.list(user, { venueId })).items.slice(0, 5);
    return result;
  }

  // ---- opening (documented handover) ---------------------------------------------------------

  /** Whose drawer a request is about, with the same permission rules for opening and closing. */
  private async resolveDrawer(
    user: AuthenticatedUser,
    dto: { scope: 'mine' | 'user' | 'shared'; targetUserId?: string },
    verb: 'open' | 'close',
  ): Promise<{ drawerUserId: string | null; userIds: string[] | null }> {
    const reviewer = await this.canReview(user);
    if (dto.scope === 'mine') return { drawerUserId: user.id, userIds: [user.id] };
    if (dto.scope === 'user') {
      if (!dto.targetUserId) {
        throw new ApiException(HttpStatus.BAD_REQUEST, 'TARGET_REQUIRED', `Say whose drawer you are ${verb === 'open' ? 'taking over' : 'closing'}`);
      }
      if (dto.targetUserId !== user.id && !reviewer) throw new ForbiddenException(`You can only ${verb} your own drawer`);
      return { drawerUserId: dto.targetUserId, userIds: [dto.targetUserId] };
    }
    if (!reviewer) throw new ForbiddenException(`Only the owner or a reviewer can ${verb} the shared drawer`);
    return { drawerUserId: null, userIds: null };
  }

  private openHandover(db: Db, venueId: string, drawerUserId: string | null) {
    return db.cashHandover.findFirst({ where: { venueId, drawerUserId, shiftId: null }, orderBy: { openedAt: 'desc' } });
  }

  /**
   * Taking a drawer over: the incoming person counts what is there, the system compares it with what
   * the last close said it left, and the difference is written down and sent to the owner. The shift
   * that follows starts from this counted float. Optional — a venue that never opens shifts still works.
   */
  async openShift(user: AuthenticatedUser, dto: OpenShiftDto) {
    const venue = await assertVenueAccess(this.prisma, user, dto.venueId, { write: true });
    const { drawerUserId } = await this.resolveDrawer(user, dto, 'open');
    const scale=isoMoneyScale(venue.currency);const encode=(v:number)=>this.encodeCash(v,scale);
    const handover = await this.prisma.$transaction(
      async (tx) => {
        if (await this.openHandover(tx, dto.venueId, drawerUserId)) {
          throw new ApiException(HttpStatus.CONFLICT, 'SHIFT_ALREADY_OPEN', 'This drawer was already taken over and has not been closed yet');
        }
        const suggested = await this.suggestedFloat(tx, dto.venueId, drawerUserId);
        const created = await tx.cashHandover.create({
          data: {
            venueId: dto.venueId,
            drawerUserId,
            openedByUserId: user.id,
            moneyScale:scale,expectedFloat: encode(suggested.float),
            countedFloat: encode(dto.countedFloat),
            difference: encode(dto.countedFloat-suggested.float),
            currency: venue.currency,
            note: dto.note?.trim() || null,
          },
        });
        await tx.auditLogEntry.create({
          data: {
            actorUserId: user.id,
            action: 'owner.shift.opened',
            targetType: 'cash_handover',
            targetId: created.id,
            metadata: {
              venueId: dto.venueId,
              drawerUserId,
              expectedFloat: suggested.float,
              countedFloat: dto.countedFloat,
              difference: created.difference,
            } as Prisma.InputJsonValue,
          },
        });
        return created;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    await this.notifyOwnerOfHandoverDifference(venue.ownerId, venue.nameAr, venue.nameEn, user, handover).catch(() => undefined);
    return this.handoverDto(handover, new Map([[user.id, user.name ?? null]]));
  }

  private handoverDto(h: CashHandover, names: Map<string, string | null>) {
    return {
      id: h.id,
      openedAt: h.openedAt.toISOString(),
      openedByUserId: h.openedByUserId,
      openedByName: names.get(h.openedByUserId) ?? null,
      expectedFloat: rescaleMoney(h.expectedFloat,h.moneyScale??100,100),
      countedFloat: rescaleMoney(h.countedFloat,h.moneyScale??100,100),
      difference: rescaleMoney(h.difference,h.moneyScale??100,100),
      note: h.note,
    };
  }

  private async notifyOwnerOfHandoverDifference(
    ownerId: string,
    venueAr: string,
    venueEn: string,
    opener: AuthenticatedUser,
    handover: CashHandover,
  ) {
    if (!this.notifications || handover.difference === 0 || opener.id === ownerId) return;
    const less = handover.difference < 0;
    const amount = rescaleMoney(Math.abs(handover.difference),handover.moneyScale??100,100);
    const who = opener.name ?? '—';
    await this.notifications.create({
      userId: ownerId,
      category: 'system',
      titleEn: `${venueEn}: handover found ${moneyText(amount, handover.currency, 'en')} ${less ? 'less' : 'more'} than the last shift left`,
      titleAr: `${venueAr}: استلام الخزنة لقى ${moneyText(amount, handover.currency, 'ar')} ${less ? 'أقل' : 'أكتر'} من اللي سابته الوردية اللي قبلها`,
      bodyEn: `${who} took the drawer over and counted differently. Review it in Earnings → Cash & shifts.`,
      bodyAr: `${who} استلم الخزنة وعدّها بشكل مختلف. راجعها من الأرباح ← الخزنة والورديات.`,
      deepLink: '/owner/earnings?section=shifts',
      payload: { venueId: handover.venueId, handoverId: handover.id },
    });
  }

  // ---- closing ---------------------------------------------------------------------------------

  async closeShift(user: AuthenticatedUser, dto: CloseShiftDto) {
    const venue = await assertVenueAccess(this.prisma, user, dto.venueId, { write: true });
    const { drawerUserId, userIds } = await this.resolveDrawer(user, dto, 'close');
    const currency = venue.currency,scale=isoMoneyScale(currency);const encode=(v:number)=>this.encodeCash(v,scale);

    const shift = await this.prisma.$transaction(
      async (tx) => {
        const { payments, expenses } = await this.movements(tx, dto.venueId, userIds);
        const foreign = foreignCurrencyRows(currency, payments, expenses);
        if (foreign.length) {
          throw new ApiException(
            HttpStatus.CONFLICT,
            'MIXED_CURRENCY',
            `${foreign.length} movement(s) in this drawer are not in ${currency}. Fix them before closing the shift.`,
          );
        }
        const t = tally(payments, expenses);
        const handover = await this.openHandover(tx, dto.venueId, drawerUserId);
        // A drawer that was taken over can be closed even if nothing moved: the handover itself is the record.
        if (t.count === 0 && !handover) {
          throw new ApiException(HttpStatus.CONFLICT, 'NOTHING_TO_CLOSE', 'There is nothing in this drawer to close');
        }
        const suggested = await this.suggestedFloat(tx, dto.venueId, drawerUserId);
        // The float the incoming person actually counted beats a guessed one.
        const openingFloat = dto.openingFloat ?? (handover?rescaleMoney(handover.countedFloat,handover.moneyScale??100,100):suggested.float);
        const carryOver = dto.carryOver ?? 0;
        if (carryOver > dto.countedCash) {
          throw new ApiException(HttpStatus.BAD_REQUEST, 'CARRY_OVER_TOO_HIGH', 'You cannot leave more in the drawer than you counted');
        }
        const { expectedCash, difference } = reconcile({ openingFloat, cashNet: t.cashNet, countedCash: dto.countedCash });
        const created = await tx.cashShift.create({
          data: {
            venueId: dto.venueId,
            drawerUserId,
            closedByUserId: user.id,
            periodStart: handover?.openedAt ?? t.since ?? new Date(),
            moneyScale:scale,openingFloat:encode(openingFloat),
            cashIn: encode(t.cashIn),
            cashRefunds: encode(t.cashRefunds),
            cashExpenses: encode(t.cashExpenses),
            expectedCash: encode(expectedCash),
            countedCash: encode(dto.countedCash),
            difference: encode(difference),
            carryOver: encode(carryOver),
            currency,
            breakdown: t.byMethod.map(m=>({...m,in:encode(m.in),out:encode(m.out)})) as unknown as Prisma.InputJsonValue,
            note: dto.note?.trim() || null,
          },
        });
        // Stamp exactly what was counted; if anything moved underneath us, abort rather than miscount.
        const stamped = await tx.payment.updateMany({
          where: { id: { in: t.paymentIds }, shiftId: null },
          data: { shiftId: created.id },
        });
        const stampedExpenses = await tx.venueExpense.updateMany({
          where: { id: { in: t.expenseIds }, shiftId: null },
          data: { shiftId: created.id },
        });
        if (stamped.count !== t.paymentIds.length || stampedExpenses.count !== t.expenseIds.length) {
          throw new ConflictException({ code: 'DRAWER_CHANGED', message: 'The drawer changed while you were closing it. Try again.' });
        }
        if (handover) {
          await tx.cashHandover.update({ where: { id: handover.id }, data: { shiftId: created.id } });
        }
        await tx.auditLogEntry.create({
          data: {
            actorUserId: user.id,
            action: 'owner.shift.closed',
            targetType: 'cash_shift',
            targetId: created.id,
            metadata: {
              venueId: dto.venueId,
              scope: dto.scope,
              drawerUserId,
              expectedCash,
              countedCash: dto.countedCash,
              difference,
            } as Prisma.InputJsonValue,
          },
        });
        return created;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    await this.notifyOwnerOfDifference(venue.ownerId, venue.nameAr, venue.nameEn, user, shift).catch(() => undefined);
    return (await this.dtos([shift]))[0];
  }

  private async notifyOwnerOfDifference(
    ownerId: string,
    venueAr: string,
    venueEn: string,
    closer: AuthenticatedUser,
    shift: CashShift,
  ) {
    if (!this.notifications || shift.difference === 0 || closer.id === ownerId) return;
    const short = shift.difference < 0;
    const amount = rescaleMoney(Math.abs(shift.difference),shift.moneyScale??100,100);
    const who = closer.name ?? '—';
    await this.notifications.create({
      userId: ownerId,
      category: 'system',
      titleEn: `${venueEn}: drawer ${short ? 'short' : 'over'} by ${moneyText(amount, shift.currency, 'en')}`,
      titleAr: `${venueAr}: الخزنة ${short ? 'ناقصة' : 'زيادة'} ${moneyText(amount, shift.currency, 'ar')}`,
      bodyEn: `${who} closed the drawer. Review it in Earnings → Cash & shifts.`,
      bodyAr: `${who} قفل الخزنة. راجعها من الأرباح ← الخزنة والورديات.`,
      deepLink: '/owner/earnings?section=shifts',
      payload: { venueId: shift.venueId, shiftId: shift.id },
    });
  }

  // ---- history ---------------------------------------------------------------------------------

  async list(user: AuthenticatedUser, q: Pick<ShiftListQueryDto, 'venueId'> & Partial<ShiftListQueryDto>) {
    const venue = await assertVenueAccess(this.prisma, user, q.venueId, { write: false });
    const reviewer = await this.canReview(user);
    const where: Prisma.CashShiftWhereInput = { venueId: q.venueId };
    if (!reviewer) where.OR = [{ drawerUserId: user.id }, { closedByUserId: user.id }];
    else if (q.userId) where.OR = [{ drawerUserId: q.userId }, { closedByUserId: q.userId }];
    if (q.unbalanced === '1' || q.unbalanced === 'true') where.difference = { not: 0 };
    if (q.from || q.to) {
      const tz = (await this.prisma.venue.findUnique({ where: { id: venue.id }, select: { country: { select: { timezone: true } } } }))?.country?.timezone ?? 'Africa/Cairo';
      const r = resolveOwnerRange('custom', tz, q.from ?? q.to, q.to ?? q.from);
      where.closedAt = { gte: r.start, lt: r.end };
    }
    const rows = await this.prisma.cashShift.findMany({
      where,
      orderBy: [{ closedAt: 'desc' }, { id: 'desc' }],
      take: SHIFT_LIST_LIMIT + 1,
      ...(q.cursor ? { skip: 1, cursor: { id: q.cursor } } : {}),
    });
    const hasMore = rows.length > SHIFT_LIST_LIMIT;
    const page = hasMore ? rows.slice(0, SHIFT_LIST_LIMIT) : rows;
    const totals = await this.prisma.cashShift.groupBy({by:['moneyScale'],where,_sum:{difference:true},_count:{_all:true}});
    return {
      items: await this.dtos(page),
      nextCursor: hasMore ? page[page.length - 1].id : undefined,
      summary: { shifts: totals.reduce((n,g)=>n+g._count._all,0), difference: totals.reduce((n,g)=>n+rescaleMoney(g._sum.difference??0,g.moneyScale,100),0) },
    };
  }

  /** One closed shift with every movement behind it, so each pound can be explained. */
  async detail(user: AuthenticatedUser, shiftId: string) {
    const shift = await this.prisma.cashShift.findUnique({ where: { id: shiftId } });
    if (!shift) throw new NotFoundException('Shift not found');
    await assertVenueAccess(this.prisma, user, shift.venueId, { write: false });
    if (!(await this.canReview(user)) && shift.drawerUserId !== user.id && shift.closedByUserId !== user.id) {
      throw new ForbiddenException('Not your shift');
    }
    const [payments, expenses] = await Promise.all([
      this.prisma.payment.findMany({
        where: { shiftId },
        orderBy: { createdAt: 'asc' },
        include: { booking: { select: { id: true, code: true, guestName: true, slotStart: true, source: true, user: { select: { name: true } } } }, gamingOrder: { select: { id: true, guestName: true, createdAt: true } } },
      }),
      this.prisma.venueExpense.findMany({ where: { shiftId }, orderBy: { createdAt: 'asc' } }),
    ]);
    const names = await this.names(payments.map((p) => p.recordedByUserId).filter((x): x is string => !!x));
    return {
      ...(await this.dtos([shift]))[0],
      payments: payments.map((p) => ({
        id: p.id,
        amount: legacyMoney(p),
        method: p.method,
        at: p.createdAt.toISOString(),
        byName: p.recordedByUserId ? (names.get(p.recordedByUserId) ?? null) : null,
        note: p.note,
        bookingId: p.booking?.id ?? null,
        orderId: p.gamingOrder?.id ?? null,
        bookingCode: p.booking?.code ?? p.gamingOrder?.id ?? null,
        customer: p.booking ? (p.booking.source === 'manual' ? p.booking.guestName : p.booking.user?.name ?? null) : p.gamingOrder?.guestName ?? null,
        slotStart: (p.booking?.slotStart ?? p.gamingOrder?.createdAt)?.toISOString() ?? null,
      })),
      expenses: expenses.map((e) => ({ id: e.id, amount: e.amount, category: e.category, categoryLabel: e.categoryLabel, note: e.note, at: e.createdAt.toISOString() })),
    };
  }

  async review(user: AuthenticatedUser, shiftId: string, note?: string) {
    const shift = await this.prisma.cashShift.findUnique({ where: { id: shiftId } });
    if (!shift) throw new NotFoundException('Shift not found');
    await assertVenueAccess(this.prisma, user, shift.venueId, { write: true });
    const updated = await this.prisma.cashShift.update({
      where: { id: shiftId },
      data: { reviewedAt: new Date(), reviewedById: user.id, reviewNote: note?.trim() || null },
    });
    await this.prisma.auditLogEntry.create({
      data: {
        actorUserId: user.id,
        action: 'owner.shift.reviewed',
        targetType: 'cash_shift',
        targetId: shiftId,
        metadata: { venueId: shift.venueId, shiftId, difference: shift.difference, currency: shift.currency, ...(note?.trim() ? { note: note.trim().slice(0, 300) } : {}) } as Prisma.InputJsonValue,
      },
    });
    return (await this.dtos([updated]))[0];
  }

  // ---- shaping ---------------------------------------------------------------------------------

  private encodeCash(value:number,scale:number){const amount=rescaleMoney(value,100,scale);if(!Number.isFinite(amount)||Math.abs(amount-Math.round(amount))>.00001||Math.abs(amount)>2147483647)throw new ApiException(HttpStatus.BAD_REQUEST,'CASH_PRECISION_INVALID','Amount has more digits than the venue currency allows');return Math.round(amount);}
  private async names(ids: string[]): Promise<Map<string, string | null>> {
    const unique = [...new Set(ids.filter(Boolean))];
    if (!unique.length) return new Map();
    const users = await this.prisma.user.findMany({ where: { id: { in: unique } }, select: { id: true, name: true } });
    return new Map(users.map((u) => [u.id, u.name]));
  }

  private async dtos(rows: CashShift[]) {
    const handovers = await this.prisma.cashHandover.findMany({ where: { shiftId: { in: rows.map((r) => r.id) } } });
    const byShift = new Map(handovers.map((h) => [h.shiftId, h]));
    const names = await this.names(
      [...rows.flatMap((r) => [r.drawerUserId, r.closedByUserId, r.reviewedById]), ...handovers.map((h) => h.openedByUserId)].filter((x): x is string => !!x),
    );
    return rows.map((r) => ({
      handover: byShift.get(r.id) ? this.handoverDto(byShift.get(r.id)!, names) : null,
      id: r.id,
      venueId: r.venueId,
      scope: r.drawerUserId == null ? ('shared' as const) : ('person' as const),
      drawerUserId: r.drawerUserId,
      drawerName: r.drawerUserId ? (names.get(r.drawerUserId) ?? null) : null,
      closedByUserId: r.closedByUserId,
      closedByName: names.get(r.closedByUserId) ?? null,
      periodStart: r.periodStart.toISOString(),
      closedAt: r.closedAt.toISOString(),
      openingFloat: rescaleMoney(r.openingFloat,r.moneyScale??100,100),
      cashIn: rescaleMoney(r.cashIn,r.moneyScale??100,100),
      cashRefunds: rescaleMoney(r.cashRefunds,r.moneyScale??100,100),
      cashExpenses: rescaleMoney(r.cashExpenses,r.moneyScale??100,100),
      expectedCash: rescaleMoney(r.expectedCash,r.moneyScale??100,100),
      countedCash: rescaleMoney(r.countedCash,r.moneyScale??100,100),
      difference: rescaleMoney(r.difference,r.moneyScale??100,100),
      carryOver: rescaleMoney(r.carryOver,r.moneyScale??100,100),
      handedOver: rescaleMoney(r.countedCash-r.carryOver,r.moneyScale??100,100),
      currency: r.currency,
      breakdown: (r.breakdown as unknown as MethodTally[]).map(m=>({...m,in:rescaleMoney(m.in,r.moneyScale??100,100),out:rescaleMoney(m.out,r.moneyScale??100,100)})),
      note: r.note,
      reviewedAt: r.reviewedAt?.toISOString() ?? null,
      reviewedByName: r.reviewedById ? (names.get(r.reviewedById) ?? null) : null,
      reviewNote: r.reviewNote,
    }));
  }
}
