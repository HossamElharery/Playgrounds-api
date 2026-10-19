import { ServiceUnavailableException } from '@nestjs/common';
import type { CheckoutSession, GatewayEvent, PaymentGateway } from '../payment-gateway.interface';

/** The default: no provider configured, so nothing online can happen. Fail-closed. */
export class DisabledGateway implements PaymentGateway {
  readonly name = 'none';
  readonly isLive = false;

  private refuse(): never {
    throw new ServiceUnavailableException({
      code: 'ONLINE_PAYMENTS_NOT_LIVE',
      message: 'Online payments are not available right now',
    });
  }
  async createCheckout(): Promise<CheckoutSession> {
    return this.refuse();
  }
  parseWebhook(): GatewayEvent {
    return this.refuse();
  }
  async fetchStatus(): Promise<GatewayEvent | null> {
    return this.refuse();
  }
  async refund(): Promise<{ providerRefundRef: string }> {
    return this.refuse();
  }
}
