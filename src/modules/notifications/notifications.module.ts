import { Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';
import { WebPushService } from './web-push.service';
import { RealtimeModule } from '../realtime/realtime.module';

@Module({
  imports: [RealtimeModule],
  providers: [NotificationsService, WebPushService],
  controllers: [NotificationsController],
  exports: [NotificationsService, WebPushService],
})
export class NotificationsModule {}
