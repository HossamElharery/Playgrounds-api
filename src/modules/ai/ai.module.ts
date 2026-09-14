import { Module } from '@nestjs/common';
import { AiProviderService } from './ai-provider.service';
import { AiContextService } from './ai-context.service';
import { GeoModule } from '../geo/geo.module';

@Module({
  imports: [GeoModule],
  providers: [AiProviderService, AiContextService],
  exports: [AiProviderService, AiContextService],
})
export class AiModule {}
