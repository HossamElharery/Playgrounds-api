import { Module } from '@nestjs/common';
import { BundlesService } from './bundles.service';
import { BundlesController } from './bundles.controller';
import { PaymentsModule } from '../payments/payments.module';
import { FinanceModule } from '../finance/finance.module';

@Module({
  imports: [PaymentsModule, FinanceModule],
  providers: [BundlesService],
  controllers: [BundlesController],
})
export class BundlesModule {}
