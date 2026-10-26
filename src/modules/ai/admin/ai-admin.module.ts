import { Module } from '@nestjs/common';
import { AiModule } from '../ai.module';
import { SearchModule } from '../../search/search.module';
import { SubscriptionsModule } from '../../subscriptions/subscriptions.module';
import { VenueAiCreditModule } from '../credit/venue-ai-credit.module';
import { AiAdminCreditService } from './ai-admin-credit.service';
import { AiAdminController } from './ai-admin.controller';
import { AiAdminOverviewService } from './ai-admin-overview.service';
import { AiAdminQuestionsService } from './ai-admin-questions.service';
import { AiAdminKnowledgeService } from './ai-admin-knowledge.service';
import { AiAdminQualityService } from './ai-admin-quality.service';

@Module({
  imports: [AiModule, SearchModule, SubscriptionsModule, VenueAiCreditModule],
  controllers: [AiAdminController],
  providers: [AiAdminOverviewService, AiAdminQuestionsService, AiAdminKnowledgeService, AiAdminQualityService, AiAdminCreditService],
})
export class AiAdminModule {}
