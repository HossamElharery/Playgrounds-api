import { BadRequestException } from '@nestjs/common';

/**
 * A venue has exactly one currency (its country's, copied onto `Venue.currency`).
 * Prices, bookings, payments, shifts and reports all take it from there — nothing
 * guesses it from a price list or falls back to a hard-coded default.
 */
export function assertVenueCurrency(venueCurrency: string, requested?: string | null): void {
  if (requested && requested.toUpperCase() !== venueCurrency.toUpperCase()) {
    throw new BadRequestException({
      code: 'VENUE_CURRENCY_MISMATCH',
      message: `This venue trades in ${venueCurrency}; ${requested} cannot be used`,
    });
  }
}
