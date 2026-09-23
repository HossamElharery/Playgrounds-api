import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../common/decorators/public.decorator';
import { SearchService } from './search.service';
import { GlobalSearchService } from './global-search.service';
import { SmartSearchDto } from './dto/smart-search.dto';
import { GlobalSearchDto } from './dto/global-search.dto';

@ApiTags('search')
@Controller('search')
export class SearchController {
  constructor(
    private readonly search: SearchService,
    private readonly global: GlobalSearchService,
  ) {}

  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get()
  globalSearch(@Query() dto: GlobalSearchDto) {
    return this.global.search(dto);
  }

  // Public + costs a real AI call per request — throttled well under the
  // global limit so a runaway client can't burn through the AI budget.
  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('smart')
  smartSearch(@Body() dto: SmartSearchDto) {
    return this.search.smartSearch(dto);
  }
}
