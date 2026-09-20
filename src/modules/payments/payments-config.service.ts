import { Inject, Injectable } from '@nestjs/common';
import {
  PAYMENT_PROVIDER,
  PaymentProvider,
} from './payment-provider.interface';

@Injectable()
export class PaymentsConfigService {
  constructor(
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
  ) {}

  isOnlinePaymentsLive(): boolean {
    return this.provider.isLive === true;
  }
}
