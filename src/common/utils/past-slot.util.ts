import { HttpStatus } from '@nestjs/common';
import { ApiException } from '../errors/api-exception';

/**
 * A venue can log a walk-in for a slot that is starting right now, and the
 * form takes a few seconds to submit — so a start up to this far in the past is
 * still "now". Anything older is history and can never be booked.
 */
export const PAST_SLOT_GRACE_MS = 15 * 60_000;

export function isPastSlotStart(start: Date, now: number = Date.now()): boolean {
  return start.getTime() < now - PAST_SLOT_GRACE_MS;
}

export function assertSlotNotInPast(start: Date): void {
  if (isPastSlotStart(start)) {
    throw new ApiException(
      HttpStatus.BAD_REQUEST,
      'SLOT_IN_PAST',
      'This time has already passed and cannot be booked',
    );
  }
}
