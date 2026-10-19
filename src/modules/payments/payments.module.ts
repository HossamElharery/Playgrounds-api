import { Module } from '@nestjs/common';
import { PAYMENT_PROVIDER } from './payment-provider.interface';
import { MockPaymentProvider } from './mock-payment.provider';
import { WalletService } from './wallet.service';
import { WalletController } from './wallet.controller';
import { NotificationsModule } from '../notifications/notifications.module';
import { PaymentsConfigService } from './payments-config.service';
import { ConfigService } from '@nestjs/config';
import { PAYMENT_GATEWAY } from './payment-gateway.interface';
import { createGateway } from './gateways/create-gateway';

@Module({
  imports: [NotificationsModule],
  providers: [
    MockPaymentProvider,
    { provide: PAYMENT_PROVIDER, useExisting: MockPaymentProvider },
    WalletService,
    PaymentsConfigService,
    { provide: PAYMENT_GATEWAY, useFactory: (config: ConfigService) => createGateway(config), inject: [ConfigService] },
  ],
  controllers: [WalletController],
  exports: [PAYMENT_PROVIDER, PAYMENT_GATEWAY, WalletService, PaymentsConfigService],
})
export class PaymentsModule {}
