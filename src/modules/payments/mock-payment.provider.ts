import { Injectable } from '@nestjs/common';
import { PaymentMethod } from '@prisma/client';
import { randomUUID } from 'crypto';
import { ChargeResult, PaymentProvider } from './payment-provider.interface';

/**
 * Mock Egypt-localized checkout: card/wallet/InstaPay settle instantly,
 * Fawry is a pay-code (pending until the user pays at an outlet — modeled
 * here as instantly "paid" for demo purposes), cash-at-venue stays pending
 * until check-in. Swap for a real PSP integration by implementing
 * PaymentProvider and pointing PAYMENT_PROVIDER at it.
 */
@Injectable()
export class MockPaymentProvider implements PaymentProvider {
  async charge(
    _amount: number,
    _currency: string,
    method: PaymentMethod,
  ): Promise<ChargeResult> {
    if (method === 'cash') return { status: 'pending' };
    return { status: 'paid', providerRef: `mock_${randomUUID()}` };
  }

  async refund(
    _amount: number,
    _currency: string,
    providerRef?: string,
  ): Promise<ChargeResult> {
    return {
      status: 'paid',
      providerRef: providerRef ?? `mock_refund_${randomUUID()}`,
    };
  }
}
