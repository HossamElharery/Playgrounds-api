import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AiLogService } from '../../ai/ai-log.service';
import { AssistantTranscriptService } from '../../ai/transcript/assistant-transcript.service';
import { OwnerBookingsService } from '../owner-bookings.service';
import { ExpensesService } from '../expenses/expenses.service';
import { bi, type AssistantAction, type Bi } from './assistant.types';
import { fmtMoney as fmt } from './assistant-money';
import { joinBi } from './assistant-reading';
import { assertActionShape } from './assistant-action-shape';
import {
  UNDO_ANCHOR_TEXT,
  UNDO_WINDOW_MS,
  UNDO_KIND,
  isUndoRecord,
  type AssistantExecuteResult,
  type AssistantUndoResult,
  type UndoOp,
} from './assistant-undo';
import { assertVenueAccess } from '../../../common/access/owner-access';
import { loadStaffScope, scopeCan } from '../../../common/access/staff-scope';
import type { PermissionKey } from '../../../common/access/permissions';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.interface';

export const MAX_ACTIONS = 4;

@Injectable()
export class OwnerAssistantExecutorService {
  private readonly logger = new Logger(OwnerAssistantExecutorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly bookings: OwnerBookingsService,
    private readonly expenses: ExpensesService,
    @Optional() private readonly logs?: AiLogService,
    @Optional() private readonly transcript?: AssistantTranscriptService,
  ) {}

  async execute(
    user: AuthenticatedUser,
    venueId: string,
    actions: AssistantAction[],
  ): Promise<AssistantExecuteResult> {
    const kinds = [...new Set(actions.map((a) => a.kind))].join('+');
    try {
      const result = await this.runActions(user, venueId, actions);
      this.logs?.logOwnerEvent({ venueId, userId: user.id, event: 'applied', intent: kinds, outcome: 'applied' });
      void this.transcript?.recordEvent({
        ownerId: user.id,
        ownerName: user.name,
        venueId,
        kind: 'action',
        intent: kinds,
        outcome: 'applied',
        text: `نُفِّذ بعد تأكيد صاحب المنشأة:\n${result.reply.ar}`,
        meta: { actions },
      });
      return result;
    } catch (err) {
      this.logs?.logOwnerEvent({
        venueId,
        userId: user.id,
        event: 'applied',
        intent: kinds,
        outcome: 'failed',
        detail: err instanceof Error ? err.constructor.name : 'error',
      });
      void this.transcript?.recordEvent({
        ownerId: user.id,
        ownerName: user.name,
        venueId,
        kind: 'action',
        intent: kinds,
        outcome: 'failed',
        text: `فشل التنفيذ بعد التأكيد: ${err instanceof Error ? err.message : 'خطأ غير معروف'}`,
        meta: { actions },
      });
      throw err;
    }
  }

  private async runActions(
    user: AuthenticatedUser,
    venueId: string,
    actions: AssistantAction[],
  ): Promise<AssistantExecuteResult> {
    const venue = await assertVenueAccess(this.prisma, user, venueId, {
      write: true,
    });
    if (!actions.length || actions.length > MAX_ACTIONS) {
      throw new BadRequestException(
        `actions must contain 1-${MAX_ACTIONS} items`,
      );
    }
    const currency = venue.currency;
    const done: string[] = [];
    const lines: Bi[] = [];
    const undo: UndoOp[] = [];
    let undoId: string | null = null;

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
      assertActionShape(action);
    }

    try {
      for (const action of actions) {
        switch (action.kind) {
          case 'create_booking': {
            let restore: (() => Promise<void>) | undefined;
            if (action.overrideBlocks) {
              if (!(await this.can(user, venueId, 'schedule.manage'))) {
                throw new ForbiddenException(
                  'Missing permission: schedule.manage',
                );
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
              await restore?.();
              throw err;
            }
            done.push(booking.id);
            undo.push({ op: 'void_booking', bookingId: booking.id });
            lines.push(
              bi(
                `اتسجل الحجز ✅ (${booking.code})`,
                `Booking recorded ✅ (${booking.code})`,
              ),
            );
            break;
          }
          case 'record_payment': {
            const known = new Set(
              (
                await this.prisma.payment.findMany({
                  where: { bookingId: action.bookingId },
                  select: { id: true },
                })
              ).map((p) => p.id),
            );
            const booking = await this.bookings.addManualPayment(
              user,
              action.bookingId,
              action.amount,
              action.method,
              action.requestKey,
            );
            done.push(booking.id);
            const fresh = await this.prisma.payment.findFirst({
              where: {
                bookingId: action.bookingId,
                status: 'paid',
                id: { notIn: [...known] },
              },
              orderBy: { createdAt: 'desc' },
              select: { id: true },
            });
            if (fresh)
              undo.push({
                op: 'void_payment',
                bookingId: booking.id,
                paymentId: fresh.id,
              });
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
              { refundAmount: action.refundAmount },
            );
            done.push(booking.id);
            undo.push({ op: 'restore_booking', bookingId: booking.id });
            lines.push(bi('اتلغى الحجز ✅', 'Booking cancelled ✅'));
            break;
          }
          case 'update_booking': {
            const before = await this.prisma.booking.findUnique({
              where: { id: action.bookingId },
              select: {
                courtId: true,
                slotStart: true,
                slotEnd: true,
                totalAmount: true,
              },
            });
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
            if (before)
              undo.push({
                op: 'revert_booking',
                bookingId: booking.id,
                courtId: before.courtId,
                startsAt: before.slotStart.toISOString(),
                durationMinutes: Math.round(
                  (before.slotEnd.getTime() - before.slotStart.getTime()) /
                    60_000,
                ),
                priceAmount: before.totalAmount,
              });
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
            undo.push({ op: 'remove_expense', expenseId: expense.id });
            lines.push(bi('اتسجل المصروف ✅', 'Expense recorded ✅'));
            break;
          }
          default:
            throw new BadRequestException('Unsupported action');
        }
      }
    } finally {
      // Persisted even when a later action threw: the earlier ones did happen.
      undoId = await this.recordUndo(user, venueId, undo);
    }
    return { ok: true, reply: joinBi(lines, '\n'), done, undoId };
  }

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
        await make(
          b.courtId,
          b.startsAt,
          new Date(Math.min(start.getTime(), b.endsAt.getTime())),
        );
        await make(
          b.courtId,
          new Date(Math.max(end.getTime(), b.startsAt.getTime())),
          b.endsAt,
        );
        if (b.courtId === null) {
          const from = new Date(
            Math.max(start.getTime(), b.startsAt.getTime()),
          );
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

  private async recordUndo(
    user: AuthenticatedUser,
    venueId: string,
    inverse: UndoOp[],
  ): Promise<string | null> {
    if (!inverse.length) return null;
    try {
      const row = await this.prisma.assistantMessage.create({
        data: {
          venueId,
          ownerId: user.id,
          sender: 'system',
          text: UNDO_ANCHOR_TEXT,
          appliedChange: { kind: UNDO_KIND, v: 1, inverse } as never,
        },
        select: { id: true },
      });
      return row.id;
    } catch (err) {
      this.logger.warn(`could not record undo: ${err}`);
      return null;
    }
  }

  async undo(
    user: AuthenticatedUser,
    venueId: string,
    undoId: string,
  ): Promise<AssistantUndoResult> {
    try {
      const result = await this.runUndo(user, venueId, undoId);
      this.logs?.logOwnerEvent({ venueId, userId: user.id, event: 'undone', outcome: result.ok ? 'applied' : 'failed', detail: result.ok ? undefined : 'partial' });
      void this.transcript?.recordEvent({
        ownerId: user.id,
        ownerName: user.name,
        venueId,
        kind: 'undo',
        outcome: result.ok ? 'undone' : 'failed',
        text: `تراجع صاحب المنشأة عن آخر تنفيذ:\n${result.reply.ar}`,
      });
      return result;
    } catch (err) {
      this.logs?.logOwnerEvent({ venueId, userId: user.id, event: 'undone', outcome: 'failed', detail: err instanceof Error ? err.constructor.name : 'error' });
      void this.transcript?.recordEvent({
        ownerId: user.id,
        ownerName: user.name,
        venueId,
        kind: 'undo',
        outcome: 'failed',
        text: `محاولة تراجع فشلت: ${err instanceof Error ? err.message : 'خطأ غير معروف'}`,
      });
      throw err;
    }
  }

  private async runUndo(
    user: AuthenticatedUser,
    venueId: string,
    undoId: string,
  ): Promise<AssistantUndoResult> {
    await assertVenueAccess(this.prisma, user, venueId, { write: true });
    const row = await this.prisma.assistantMessage.findUnique({
      where: { id: undoId },
    });
    if (
      !row ||
      row.venueId !== venueId ||
      row.ownerId !== user.id ||
      !isUndoRecord(row.appliedChange)
    ) {
      throw new BadRequestException('Nothing to undo');
    }
    if (row.consumedAt) throw new ConflictException('Already undone');
    if (Date.now() - row.createdAt.getTime() > UNDO_WINDOW_MS) {
      throw new ConflictException('Undo window has passed');
    }
    const needed: Record<UndoOp['op'], PermissionKey> = {
      void_booking: 'bookings.edit',
      restore_booking: 'bookings.edit',
      revert_booking: 'bookings.edit',
      void_payment: 'payments.record',
      remove_expense: 'expenses.manage',
    };
    const ops = row.appliedChange.inverse;
    for (const op of ops) {
      if (!(await this.can(user, venueId, needed[op.op]))) {
        throw new ForbiddenException(`Missing permission: ${needed[op.op]}`);
      }
    }
    // Claim it first: two quick taps must not both run the inverse.
    const claimed = await this.prisma.assistantMessage.updateMany({
      where: { id: undoId, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (claimed.count !== 1) throw new ConflictException('Already undone');

    const lines: Bi[] = [];
    const failed: Bi[] = [];
    // Last write first, so each step meets the state it expects.
    for (const op of [...ops].reverse()) {
      try {
        lines.push(await this.apply(user, op));
      } catch (err) {
        this.logger.warn(`undo step ${op.op} failed: ${err}`);
        failed.push(
          bi(
            'مقدرتش أتراجع عن خطوة (اتغيّر حاجة بعدها). راجعها بإيدك.',
            'Could not reverse one step (something changed since). Please check it by hand.',
          ),
        );
      }
    }
    return {
      ok: failed.length === 0,
      reply: joinBi(failed.length ? [...lines, ...failed] : lines, '\n'),
    };
  }

  private async apply(user: AuthenticatedUser, op: UndoOp): Promise<Bi> {
    switch (op.op) {
      case 'void_booking':
        await this.bookings.deleteManualBooking(user, op.bookingId, { refundAmount: 'all' });
        return bi(
          'اتلغى الحجز اللي سجلته ↩️',
          'The booking I recorded was cancelled ↩️',
        );
      case 'restore_booking':
        await this.bookings.restoreManualBooking(user, op.bookingId);
        return bi(
          'رجّعت الحجز اللي اتلغى ↩️',
          'The cancelled booking is back ↩️',
        );
      case 'void_payment':
        await this.bookings.voidManualPayment(user, op.bookingId, op.paymentId);
        return bi(
          'اتشال الدفع اللي سجلته ↩️',
          'The payment I recorded was removed ↩️',
        );
      case 'revert_booking':
        await this.bookings.updateManualBooking(user, op.bookingId, {
          courtId: op.courtId,
          startsAt: op.startsAt,
          durationMinutes: op.durationMinutes,
          priceAmount: op.priceAmount,
        });
        return bi(
          'رجّعت الحجز زي ما كان ↩️',
          'The booking is back as it was ↩️',
        );
      case 'remove_expense':
        await this.expenses.remove(user, op.expenseId);
        return bi(
          'اتشال المصروف اللي سجلته ↩️',
          'The expense I recorded was removed ↩️',
        );
    }
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
}
