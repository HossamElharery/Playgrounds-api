import { PaymentMethod } from '@prisma/client';

export const PAYMENT_PROVIDER = 'PAYMENT_PROVIDER';

export interface ChargeResult {
  status: 'paid' | 'pending' | 'failed';
  providerRef?: string;
}

export interface PaymentProvider {
  readonly isLive: boolean;
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
