import type { Bi } from './assistant.types';

/** Discriminator stored in `AssistantMessage.appliedChange` for an undo anchor. */
export const UNDO_KIND = 'assistant_undo';

/** After this the books have moved on; reversing blindly would be a second mistake. */
export const UNDO_WINDOW_MS = 15 * 60_000;

/** One step that puts a single write of the assistant back. Built server-side only. */
export type UndoOp =
  | { op: 'void_booking'; bookingId: string }
  | { op: 'restore_booking'; bookingId: string }
  | { op: 'void_payment'; bookingId: string; paymentId: string }
  | {
      op: 'revert_booking';
      bookingId: string;
      courtId: string;
      startsAt: string;
      durationMinutes: number;
      priceAmount: number;
    }
  | { op: 'remove_expense'; expenseId: string };

export interface AssistantExecuteResult {
  ok: boolean;
  reply: Bi;
  done: string[];
  /** Present when the plan can be taken back; pass it to `assistant/undo-actions`. */
  undoId: string | null;
}

export interface AssistantUndoResult {
  ok: boolean;
  reply: Bi;
}

export function isUndoRecord(
  value: unknown,
): value is { kind: typeof UNDO_KIND; v: 1; inverse: UndoOp[] } {
  const v = value as { kind?: unknown; inverse?: unknown } | null;
  return !!v && v.kind === UNDO_KIND && Array.isArray(v.inverse);
}
