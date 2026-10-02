import { BadRequestException } from '@nestjs/common';
import { EXPENSE_CATEGORIES } from '../expenses/expenses.dto';
import type { AssistantAction } from './assistant.types';

/**
 * The action DTO cannot express "these fields are required for this kind", and
 * a half-filled action reaches Prisma as an undefined id or a NaN amount. This
 * checks the shape once, before anything is written.
 */
export function assertActionShape(action: AssistantAction): void {
  const need = (ok: unknown, field: string) => {
    if (!ok) throw new BadRequestException(`${action.kind} requires ${field}`);
  };
  switch (action.kind) {
    case 'create_booking':
      need(action.courtId, 'courtId');
      need(
        action.startsAt && !Number.isNaN(Date.parse(action.startsAt)),
        'startsAt',
      );
      need(
        Number.isInteger(action.durationMinutes) && action.durationMinutes > 0,
        'durationMinutes',
      );
      need(
        Number.isInteger(action.priceAmount) && action.priceAmount >= 0,
        'priceAmount',
      );
      need(
        ['paid', 'unpaid', 'partial'].includes(action.paymentStatus),
        'paymentStatus',
      );
      if (action.paymentStatus === 'partial') {
        need(
          Number.isInteger(action.paidAmount) &&
            (action.paidAmount as number) > 0 &&
            (action.paidAmount as number) < action.priceAmount,
          'paidAmount between 0 and priceAmount',
        );
      }
      break;
    case 'record_payment':
      need(action.bookingId, 'bookingId');
      need(
        Number.isInteger(action.amount) && action.amount > 0,
        'a positive amount',
      );
      break;
    case 'cancel_booking':
      need(action.bookingId, 'bookingId');
      break;
    case 'update_booking':
      need(action.bookingId, 'bookingId');
      need(
        action.courtId ||
          action.startsAt ||
          action.durationMinutes ||
          action.priceAmount !== undefined,
        'at least one change',
      );
      if (action.startsAt)
        need(!Number.isNaN(Date.parse(action.startsAt)), 'startsAt');
      break;
    case 'add_expense':
      need(
        EXPENSE_CATEGORIES.includes(
          action.category as (typeof EXPENSE_CATEGORIES)[number],
        ),
        'a known category',
      );
      need(
        Number.isInteger(action.amount) && action.amount > 0,
        'a positive amount',
      );
      need(
        /^\d{4}-\d{2}-\d{2}$/.test(action.incurredOn),
        'incurredOn as YYYY-MM-DD',
      );
      break;
  }
}
