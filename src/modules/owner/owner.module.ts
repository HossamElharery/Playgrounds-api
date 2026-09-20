import { Module } from '@nestjs/common';
import { OwnerService } from './owner.service';
import { OwnerController } from './owner.controller';
import { GeminiNluService } from './gemini-nlu.service';
import { BookingsModule } from '../bookings/bookings.module';
import { AiModule } from '../ai/ai.module';
import { FinanceModule } from '../finance/finance.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { OwnerBookingsService } from './owner-bookings.service';
import { OwnerSummaryService } from './owner-summary.service';

@Module({
  imports: [BookingsModule, AiModule, FinanceModule, NotificationsModule],
  providers: [OwnerService, GeminiNluService, OwnerBookingsService, OwnerSummaryService],
  controllers: [OwnerController],
  exports: [OwnerService, OwnerBookingsService, OwnerSummaryService],
})
export class OwnerModule {}
