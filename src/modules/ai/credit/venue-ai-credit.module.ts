import { Module } from '@nestjs/common';
import { AiModule } from '../ai.module';
import { SubscriptionsModule } from '../../subscriptions/subscriptions.module';
import { VenueAiCreditService } from './venue-ai-credit.service';

@Module({
  imports: [AiModule, SubscriptionsModule],
  providers: [VenueAiCreditService],
  exports: [VenueAiCreditService],
})
export class VenueAiCreditModule {}
