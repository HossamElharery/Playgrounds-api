import { Injectable, ServiceUnavailableException } from '@nestjs/common';
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
  readonly isLive = false;

  async charge(
    _amount: number,
    _currency: string,
    method: PaymentMethod,
  ): Promise<ChargeResult> {
    if (method === 'cash') return { status: 'pending' };
    if (process.env.NODE_ENV === 'production') throw new ServiceUnavailableException('A live payment provider must be configured before accepting electronic payments');
    return { status: 'paid', providerRef: `mock_${randomUUID()}` };
  }

  async refund(
    _amount: number,
    _currency: string,
    providerRef?: string,
  ): Promise<ChargeResult> {
    if (process.env.NODE_ENV === 'production') throw new ServiceUnavailableException('A live payment provider must be configured before issuing refunds');
    return {
      status: 'paid',
      providerRef: providerRef ?? `mock_refund_${randomUUID()}`,
    };
  }
}
