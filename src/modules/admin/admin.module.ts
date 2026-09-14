import { Module } from '@nestjs/common';
import { AdminService } from './admin.service';
import { AdminController } from './admin.controller';
import { NotificationsModule } from '../notifications/notifications.module';
import { ManagementService } from './management.service';
import { ManagementController } from './management.controller';
import { BookingsModule } from '../bookings/bookings.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { VenueSeoController } from './venue-seo.controller';
import { VenueSeoService } from './venue-seo.service';

@Module({
  imports: [NotificationsModule, BookingsModule, RealtimeModule],
  providers: [AdminService, ManagementService, VenueSeoService],
  controllers: [AdminController, ManagementController, VenueSeoController],
  exports: [AdminService],
})
export class AdminModule {}
