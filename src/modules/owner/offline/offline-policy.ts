import { createHash } from 'crypto';
import type { CreateManualBookingDto } from '../dto/manual-booking.dto';

export const offlineTokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
/** Explicit fields keep key order and omitted defaults stable across HTTP retries. */
export function manualBookingHash(dto: CreateManualBookingDto): string {
  return offlineTokenHash(JSON.stringify({
    venueId: dto.venueId, courtId: dto.courtId, startsAt: new Date(dto.startsAt).toISOString(),
    durationMinutes: dto.durationMinutes, priceAmount: dto.priceAmount,
    paymentStatus: dto.paymentStatus ?? 'unpaid', paidAmount: dto.paidAmount ?? null,
    paymentMethod: dto.paymentMethod ?? 'cash', customerName: dto.customerName?.trim() || null,
    customerPhone: dto.customerPhone?.trim() || null, sourceKey: dto.sourceKey ?? 'walk_in',
    sourceLabel: dto.sourceLabel?.trim() || null, notes: dto.notes?.trim() || null,
  }));
}
