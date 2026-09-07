import { Module } from '@nestjs/common';
import { MembershipService } from './membership.service';
import { MembershipController } from './membership.controller';
import { PaymentsModule } from '../payments/payments.module';
import { RealtimeModule } from '../realtime/realtime.module';

@Module({
  imports: [PaymentsModule, RealtimeModule],
  providers: [MembershipService],
  controllers: [MembershipController],
})
export class MembershipModule {}
