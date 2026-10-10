import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ApiException } from '../errors/api-exception';

/** Serialization failures roll the transaction back; never retry a money write implicitly. */
export function rethrowConcurrentWrite(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2034') {
      throw new ApiException(HttpStatus.CONFLICT, 'CONCURRENT_CHANGE', 'This record changed during the action. Refresh and check before trying again.');
    }
    if (error.code === 'P2002' && String(error.meta?.target).includes('reversesPaymentId')) {
      throw new ApiException(HttpStatus.CONFLICT, 'PAYMENT_ALREADY_REVERSED', 'This payment was already taken back');
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('BOOKING_LINKED_TO_SESSION') || message.includes('GAMING_ORDER_REQUIRED')) throw new ApiException(HttpStatus.CONFLICT, 'BOOKING_LINKED_TO_SESSION', 'Use the linked gaming order to change or refund this booking');
  if (message.includes('23P01') || message.includes('Booking_court_slot_range_excl') || message.includes('ResourceOccupancy_') || message.includes('RESOURCE_IN_USE')) {
    throw new ApiException(HttpStatus.CONFLICT, 'SLOT_ALREADY_HELD', 'This slot is already occupied');
  }
  throw error;
}
