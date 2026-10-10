import { Module } from '@nestjs/common';
import { VenuesService } from './venues.service';
import { VenuesController } from './venues.controller';
import { StorageModule } from '../storage/storage.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AiModule } from '../ai/ai.module';
import { VenueTextService } from './venue-text.service';

@Module({
  imports: [StorageModule, NotificationsModule, AiModule],
  providers: [VenuesService, VenueTextService],
  controllers: [VenuesController],
  exports: [VenuesService],
})
export class VenuesModule {}
