import { Module } from '@nestjs/common';
import { AiModule } from '../ai.module';
import { SearchModule } from '../../search/search.module';
import { AiAdminController } from './ai-admin.controller';
import { AiAdminOverviewService } from './ai-admin-overview.service';
import { AiAdminQuestionsService } from './ai-admin-questions.service';
import { AiAdminKnowledgeService } from './ai-admin-knowledge.service';
import { AiAdminQualityService } from './ai-admin-quality.service';

@Module({
  imports: [AiModule, SearchModule],
  controllers: [AiAdminController],
  providers: [AiAdminOverviewService, AiAdminQuestionsService, AiAdminKnowledgeService, AiAdminQualityService],
})
export class AiAdminModule {}
