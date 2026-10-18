import { Module } from '@nestjs/common';
import { SearchService } from './search.service';
import { GlobalSearchService } from './global-search.service';
import { SearchController } from './search.controller';
import { CaptainService } from './captain/captain.service';
import { CaptainNluService } from './captain/captain-nlu.service';
import { AiModule } from '../ai/ai.module';
import { VenuesModule } from '../venues/venues.module';

@Module({
  imports: [AiModule, VenuesModule],
  providers: [SearchService, GlobalSearchService, CaptainService, CaptainNluService],
  controllers: [SearchController],
  exports: [CaptainNluService],
})
export class SearchModule {}
