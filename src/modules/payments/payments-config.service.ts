import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  PAYMENT_PROVIDER,
  PaymentProvider,
} from './payment-provider.interface';
import { PAYMENT_GATEWAY, type PaymentGateway } from './payment-gateway.interface';

@Injectable()
export class PaymentsConfigService {
  constructor(
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    @Optional() @Inject(PAYMENT_GATEWAY) private readonly gateway?: PaymentGateway,
  ) {}

  /** A card gateway is configured and complete: bookings can be paid online by card. */
  isGatewayLive(): boolean {
    return this.gateway?.isLive === true;
  }

  /** Any online rail (card gateway, or a live wallet provider) is available. */
  isOnlinePaymentsLive(): boolean {
    return this.isGatewayLive() || this.provider.isLive === true;
  }
}
