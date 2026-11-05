import { Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';
import { WebPushService } from './web-push.service';
import { FcmService } from './fcm.service';
import { AdminAlertsService } from './admin-alerts.service';
import { RealtimeModule } from '../realtime/realtime.module';

@Module({
  imports: [RealtimeModule],
  providers: [NotificationsService, AdminAlertsService, WebPushService, FcmService],
  controllers: [NotificationsController],
  exports: [NotificationsService, AdminAlertsService, WebPushService, FcmService],
})
export class NotificationsModule {}
