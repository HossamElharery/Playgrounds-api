import { Module } from '@nestjs/common';
import { PartnersService } from './partners.service';
import { PartnersController } from './partners.controller';
import { AuthModule } from '../auth/auth.module';
import { StorageModule } from '../storage/storage.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { VenuesModule } from '../venues/venues.module';

@Module({
  imports: [AuthModule, StorageModule, NotificationsModule, VenuesModule],
  providers: [PartnersService],
  controllers: [PartnersController],
  exports: [PartnersService],
})
export class PartnersModule {}
