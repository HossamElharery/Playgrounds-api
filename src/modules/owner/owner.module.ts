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
import { FixedBookingsService } from './fixed/fixed-bookings.service';
import { PlatformRequestsController, VenueHealthController } from './requests/platform-requests.controller';
import { PlatformRequestsService } from './requests/platform-requests.service';
import { QuickstartService } from './quickstart/quickstart.service';
import { VenueHealthService } from './health/venue-health.service';
import { ExportService } from './exports/export.service';
import { ExpensesService } from './expenses/expenses.service';
import { InsightsService } from './insights/insights.service';

@Module({
  imports: [BookingsModule, AiModule, FinanceModule, NotificationsModule],
  providers: [OwnerService, GeminiNluService, OwnerBookingsService, OwnerSummaryService, InsightsService, FixedBookingsService, ExpensesService, ExportService, PlatformRequestsService, QuickstartService, VenueHealthService],
  controllers: [OwnerController, PlatformRequestsController, VenueHealthController],
  exports: [OwnerService, OwnerBookingsService, OwnerSummaryService, ExpensesService],
})
export class OwnerModule {}
