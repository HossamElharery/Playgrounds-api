import { Module } from '@nestjs/common';
import { SearchService } from './search.service';
import { GlobalSearchService } from './global-search.service';
import { SearchController } from './search.controller';
import { AiModule } from '../ai/ai.module';
import { VenuesModule } from '../venues/venues.module';

@Module({
  imports: [AiModule, VenuesModule],
  providers: [SearchService, GlobalSearchService],
  controllers: [SearchController],
})
export class SearchModule {}
