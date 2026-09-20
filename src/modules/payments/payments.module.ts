import { Module } from '@nestjs/common';
import { PAYMENT_PROVIDER } from './payment-provider.interface';
import { MockPaymentProvider } from './mock-payment.provider';
import { WalletService } from './wallet.service';
import { WalletController } from './wallet.controller';
import { NotificationsModule } from '../notifications/notifications.module';
import { PaymentsConfigService } from './payments-config.service';

@Module({
  imports: [NotificationsModule],
  providers: [
    MockPaymentProvider,
    { provide: PAYMENT_PROVIDER, useExisting: MockPaymentProvider },
    WalletService,
    PaymentsConfigService,
  ],
  controllers: [WalletController],
  exports: [PAYMENT_PROVIDER, WalletService, PaymentsConfigService],
})
export class PaymentsModule {}
