import { GamingSetupController } from './gaming/gaming-setup.controller';
import { GamingSetupService } from './gaming/gaming-setup.service';
import { GamingOutboxService } from './gaming/gaming-outbox.service';
import { GamingAlertsService } from './gaming/gaming-alerts.service';
import { RealtimeModule } from '../realtime/realtime.module';
import { GamingOperationsController } from './gaming/gaming-operations.controller';
import { GamingReceiptsService } from './gaming/gaming-receipts.service';
import { GamingCommerceService } from './gaming/gaming-commerce.service';
import { GamingSessionsService } from './gaming/gaming-sessions.service';
import { GamingCommandService } from './gaming/gaming-command.service';
import { GamingLayoutController } from './gaming/gaming-layout.controller';
import { GamingLayoutService } from './gaming/gaming-layout.service';
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
import {
  PlatformRequestsController,
  VenueHealthController,
} from './requests/platform-requests.controller';
import { PlatformRequestsService } from './requests/platform-requests.service';
import { QuickstartService } from './quickstart/quickstart.service';
import { VenueHealthService } from './health/venue-health.service';
import { ExportService } from './exports/export.service';
import { ExpensesService } from './expenses/expenses.service';
import { InsightsService } from './insights/insights.service';
import { CashService } from './cash/cash.service';
import { ImportService } from './import/import.service';
import { AssistantNluService } from './assistant/assistant-nlu.service';
import { OwnerAssistantService } from './assistant/owner-assistant.service';
import { OwnerAssistantExecutorService } from './assistant/owner-assistant-executor.service';
import { AssistantRemindersService } from './assistant/assistant-reminders.service';
import { CommandCentreService } from './command/command-centre.service';
import { ActivityService } from './activity/activity.service';

@Module({
  imports: [RealtimeModule, BookingsModule, AiModule, FinanceModule, NotificationsModule],
  providers: [
    GamingLayoutService, GamingSetupService,
    GamingOutboxService, GamingAlertsService, GamingCommandService, GamingSessionsService, GamingCommerceService, GamingReceiptsService,
    OwnerService,
    GeminiNluService,
    AssistantNluService,
    OwnerAssistantService,
    OwnerAssistantExecutorService,
    AssistantRemindersService,
    OwnerBookingsService,
    OwnerSummaryService,
    InsightsService,
    FixedBookingsService,
    ExpensesService,
    CashService,
    CommandCentreService,
    ActivityService,
    ImportService,
    ExportService,
    PlatformRequestsService,
    QuickstartService,
    VenueHealthService,
  ],
  controllers: [
    GamingLayoutController, GamingOperationsController, GamingSetupController,
    OwnerController,
    PlatformRequestsController,
    VenueHealthController,
  ],
  exports: [
    OwnerService,
    OwnerBookingsService,
    OwnerSummaryService,
    ExpensesService,
    OwnerAssistantService,
  ],
})
export class OwnerModule {}
