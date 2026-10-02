import { Module } from '@nestjs/common';
import { AiProviderService } from './ai-provider.service';
import { AiContextService } from './ai-context.service';
import { AiUsageService } from './ai-usage.service';
import { AiQuotaService } from './ai-quota.service';
import { AiCounterStore } from './ai-counter.store';
import { AiSettingsService } from './ai-settings.service';
import { AiLogService } from './ai-log.service';
import { TurnstileService } from './turnstile.service';
import { AssistantKnowledgeService } from './knowledge/assistant-knowledge.service';
import { GeoModule } from '../geo/geo.module';

const SHARED = [
  AiProviderService,
  AiContextService,
  AiUsageService,
  AiQuotaService,
  AiCounterStore,
  AiSettingsService,
  AiLogService,
  TurnstileService,
  AssistantKnowledgeService,
];

@Module({
  imports: [GeoModule],
  providers: SHARED,
  exports: SHARED,
})
export class AiModule {}
