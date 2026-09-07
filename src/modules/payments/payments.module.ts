import { Module } from '@nestjs/common';
import { PAYMENT_PROVIDER } from './payment-provider.interface';
import { MockPaymentProvider } from './mock-payment.provider';

@Module({
  providers: [
    MockPaymentProvider,
    { provide: PAYMENT_PROVIDER, useExisting: MockPaymentProvider },
  ],
  exports: [PAYMENT_PROVIDER],
})
export class PaymentsModule {}
