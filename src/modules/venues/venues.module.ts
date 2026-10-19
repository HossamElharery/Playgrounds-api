import { Module } from '@nestjs/common';
import { VenuesService } from './venues.service';
import { VenuesController } from './venues.controller';
import { StorageModule } from '../storage/storage.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AiModule } from '../ai/ai.module';
import { VenueTextService } from './venue-text.service';
import { VenueListingService } from './venue-listing.service';
import { RealtimeModule } from '../realtime/realtime.module';

@Module({
  imports: [StorageModule, NotificationsModule, AiModule, RealtimeModule],
  providers: [VenuesService, VenueTextService, VenueListingService],
  controllers: [VenuesController],
  exports: [VenuesService, VenueTextService, VenueListingService],
})
export class VenuesModule {}
