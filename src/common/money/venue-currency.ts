import { BadRequestException } from '@nestjs/common';

export function assertVenueCurrency(venueCurrency: string, requested?: string | null): void {
  if (requested && requested.toUpperCase() !== venueCurrency.toUpperCase()) {
    throw new BadRequestException({
      code: 'VENUE_CURRENCY_MISMATCH',
      message: `This venue trades in ${venueCurrency}; ${requested} cannot be used`,
    });
  }
}
