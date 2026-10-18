import type { Bi } from './assistant.types';

export const UNDO_KIND = 'assistant_undo';

export const UNDO_ANCHOR_TEXT = 'assistant-undo';

export const UNDO_WINDOW_MS = 15 * 60_000;

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
