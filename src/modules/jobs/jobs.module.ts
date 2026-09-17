import { Module } from '@nestjs/common';
import { JobsService } from './jobs.service';
import { RealtimeModule } from '../realtime/realtime.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [RealtimeModule, NotificationsModule],
  providers: [JobsService],
})
export class JobsModule {}
