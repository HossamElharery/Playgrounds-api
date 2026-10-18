import { HttpStatus } from '@nestjs/common';
import { ApiException } from '../errors/api-exception';

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
