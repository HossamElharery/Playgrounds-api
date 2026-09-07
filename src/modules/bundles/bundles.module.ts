import { Module } from '@nestjs/common';
import { BundlesService } from './bundles.service';
import { BundlesController } from './bundles.controller';
import { PaymentsModule } from '../payments/payments.module';

@Module({
  imports: [PaymentsModule],
  providers: [BundlesService],
  controllers: [BundlesController],
})
export class BundlesModule {}
