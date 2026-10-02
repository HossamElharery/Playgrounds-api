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

/** One sentence never legitimately asks for more than this. */
export const MAX_ACTIONS = 4;

/**
 * Carries out what the owner confirmed, and can take it back. Execution goes
 * through the same services the dashboard's own buttons use, so an assistant
 * action can never do something the owner (or a staff member with fewer
 * permissions) could not do by hand — and neither can its Undo.
 */
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

  /** Carries out the confirmed actions and leaves two traces: the numbers (kinds and outcome) and, in the permanent transcript, what was done and what it said. */
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
        text: `نُفِّذ بعد تأكيد صاحب الملعب:\n${result.reply.ar}`,
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
    // What it would take to put each write back, built from the rows as they
    // really were — never from anything the client sent.
    const undo: UndoOp[] = [];
    let undoId: string | null = null;

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
              // The block was opened for this booking only; if it fell through,
              // the window goes back to exactly how the owner left it.
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

  // --------------------------------------------------------------- undo ----

  /**
   * Anchors the inverse of a confirmed plan server-side. The client only ever
   * holds the row's id: what "undo" will do was decided here, from the rows as
   * they were, so a forged request cannot make it do anything else.
   */
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
      // Losing the Undo button must never turn a booking that WAS written into
      // an error the owner would answer by writing it again.
      this.logger.warn(`could not record undo: ${err}`);
      return null;
    }
  }

  /** Puts back what one confirmed plan wrote — once, and only for a short while. */
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
        text: `تراجع صاحب الملعب عن آخر تنفيذ:\n${result.reply.ar}`,
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
        await this.bookings.deleteManualBooking(user, op.bookingId);
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
