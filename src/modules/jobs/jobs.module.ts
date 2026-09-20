import { Module } from '@nestjs/common';
import { JobsService } from './jobs.service';
import { RealtimeModule } from '../realtime/realtime.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { FinanceModule } from '../finance/finance.module';

@Module({
  imports: [RealtimeModule, NotificationsModule, FinanceModule],
  providers: [JobsService],
})
export class JobsModule {}
