import { Prisma } from '@prisma/client';

/** Unique index, serialization failure, or GiST EXCLUDE overlap on live slots. */
export function isBookingSlotConflict(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2002' || error.code === 'P2034') return true;
  }
  const msg = error instanceof Error ? error.message : String(error);
  return (
    msg.includes('23P01') ||
    msg.includes('Booking_court_slot_range_excl') || msg.includes('ResourceOccupancy_')
  );
}
