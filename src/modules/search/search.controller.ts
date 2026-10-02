import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../common/decorators/public.decorator';
import { SearchService } from './search.service';
import { GlobalSearchService } from './global-search.service';
import { SmartSearchDto } from './dto/smart-search.dto';
import { GlobalSearchDto } from './dto/global-search.dto';
import { CaptainService } from './captain/captain.service';
import { CaptainAskDto, CaptainFeedbackDto } from './captain/captain.dto';
import { AiLogService } from '../ai/ai-log.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.interface';

@ApiTags('search')
@Controller('search')
export class SearchController {
  constructor(
    private readonly search: SearchService,
    private readonly global: GlobalSearchService,
    private readonly captain: CaptainService,
    private readonly aiLog: AiLogService,
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

  // The player assistant. Public like smart search (guests can look for a court),
  // but a signed-in player is recognised so "حجوزاتي" can answer. Each call may
  // cost a model call, so it is throttled well under the global limit.
  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('captain')
  captainAsk(@Body() dto: CaptainAskDto, @Req() req: { ip?: string }, @CurrentUser() user?: AuthenticatedUser) {
    return this.captain.ask(dto, user, req.ip);
  }

  // 👍 / 👎 on one Captain answer. Public like the question itself; the id is the
  // random one handed back with that answer, so only whoever got it can rate it,
  // and only for a day. Always 200 so a purged or unknown id leaks nothing.
  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Patch('captain/feedback/:id')
  async captainFeedback(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: CaptainFeedbackDto) {
    const saved = await this.aiLog.setFeedback(id, dto.value);
    return { ok: saved };
  }
}
