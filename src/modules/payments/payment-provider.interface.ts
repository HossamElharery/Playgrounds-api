import { PaymentMethod } from '@prisma/client';

export const PAYMENT_PROVIDER = 'PAYMENT_PROVIDER';

export interface ChargeResult {
  status: 'paid' | 'pending' | 'failed';
  providerRef?: string;
}

/**
 * Localized checkout abstraction. Methods are validated against
 * CountryConfig.paymentMethods at confirm time — adding a market is config,
 * not a BookingsService change.
 */
export interface PaymentProvider {
  charge(
    amount: number,
    currency: string,
    method: PaymentMethod,
  ): Promise<ChargeResult>;
  refund(
    amount: number,
    currency: string,
    providerRef?: string,
  ): Promise<ChargeResult>;
}
