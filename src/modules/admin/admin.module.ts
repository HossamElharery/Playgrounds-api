import { Module } from '@nestjs/common';
import { AdminService } from './admin.service';
import { AdminController } from './admin.controller';
import { NotificationsModule } from '../notifications/notifications.module';
import { VenueSeoController } from './venue-seo.controller';
import { VenueSeoService } from './venue-seo.service';

@Module({
  imports: [NotificationsModule],
  providers: [AdminService, VenueSeoService],
  controllers: [AdminController, VenueSeoController],
  exports: [AdminService],
})
export class AdminModule {}
