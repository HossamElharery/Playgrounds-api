import { Module } from '@nestjs/common';
import { PAYMENT_PROVIDER } from './payment-provider.interface';
import { MockPaymentProvider } from './mock-payment.provider';
import { WalletService } from './wallet.service';
import { WalletController } from './wallet.controller';

@Module({
  providers: [
    MockPaymentProvider,
    { provide: PAYMENT_PROVIDER, useExisting: MockPaymentProvider },
    WalletService,
  ],
  controllers: [WalletController],
  exports: [PAYMENT_PROVIDER, WalletService],
})
export class PaymentsModule {}
