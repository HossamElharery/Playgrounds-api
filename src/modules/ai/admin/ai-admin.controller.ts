import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthGuard } from '../../../common/guards/auth.guard';
import { Roles } from '../../../common/decorators/roles.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.interface';
import { AssistantKnowledgeService } from '../knowledge/assistant-knowledge.service';
import { AiAdminOverviewService } from './ai-admin-overview.service';
import { AiAdminQuestionsService } from './ai-admin-questions.service';
import { AiAdminKnowledgeService } from './ai-admin-knowledge.service';
import { AiAdminQualityService } from './ai-admin-quality.service';
import { AiAdminCreditService } from './ai-admin-credit.service';
import {
  AiCreditTopUpDto,
  DraftKnowledgeDto,
  KnowledgeBodyDto,
  ListAiQuestionsDto,
  ListOwnerRequestsDto,
  ListVenueCreditDto,
  OwnerRequestsSummaryDto,
  PreviewKnowledgeDto,
  ReorderKnowledgeDto,
  ResolveQuestionDto,
  RestoreKnowledgeDto,
  SetQuestionStatusDto,
  StartEvalDto,
  StartShadowDto,
  UpdateLimitsDto,
  UpdateVenueCreditDto,
  ValidateKnowledgeDto,
} from './ai-admin.dto';

@ApiTags('admin-ai')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Roles('admin')
@Controller('admin/ai')
export class AiAdminController {
  constructor(
    private readonly overview: AiAdminOverviewService,
    private readonly questions: AiAdminQuestionsService,
    private readonly tools: AiAdminKnowledgeService,
    private readonly knowledge: AssistantKnowledgeService,
    private readonly quality: AiAdminQualityService,
    private readonly credit: AiAdminCreditService,
  ) {}

  @Get('overview')
  getOverview() {
    return this.overview.overview();
  }

  @Get('questions')
  async listQuestions(@Query() q: ListAiQuestionsDto) {
    const { items, pagination } = await this.questions.list(q);
    return { message: 'ok', result: items, pagination };
  }

  @Get('owner-requests')
  async ownerRequests(@Query() q: ListOwnerRequestsDto) {
    const { items, pagination } = await this.questions.ownerRequests(q);
    return { message: 'ok', result: items, pagination };
  }

  @Get('owner-requests/summary')
  ownerRequestsSummary(@Query() q: OwnerRequestsSummaryDto) {
    return this.questions.ownerRequestsSummary(q.days);
  }

  @Get('questions/inbox')
  inbox() {
    return this.questions.inbox();
  }

  @Get('questions/counts')
  counts() {
    return this.questions.counts();
  }

  @Get('questions/:id')
  getQuestion(@Param('id') id: string) {
    return this.questions.getOne(id);
  }

  @Patch('questions/:id')
  setStatus(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: SetQuestionStatusDto) {
    return this.questions.setStatus([id, ...(dto.ids ?? [])], dto.status, dto.note, user.id);
  }

  @Post('questions/:id/resolve')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  resolve(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: ResolveQuestionDto) {
    return this.questions.resolve(id, dto, user.id);
  }

  @Post('questions/:id/retest')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  retest(@Param('id') id: string) {
    return this.questions.retest(id);
  }

  @Get('knowledge')
  async listKnowledge() {
    const [list, deleted] = await Promise.all([this.knowledge.listAll(), this.knowledge.deletedEntries()]);
    return { ...list, deleted };
  }

  @Post('knowledge/validate')
  validateKnowledge(@Body() dto: ValidateKnowledgeDto) {
    return this.knowledge.check(dto.entry, { creating: dto.creating === true }).then(({ errors, warnings }) => ({ errors, warnings, ok: Object.keys(errors).length === 0 }));
  }

  @Post('knowledge/preview')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  preview(@Body() dto: PreviewKnowledgeDto) {
    return this.tools.preview({ text: dto.text, lang: dto.lang, loggedIn: dto.loggedIn, draft: dto.draft });
  }

  @Post('knowledge/draft')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  draft(@Body() dto: DraftKnowledgeDto) {
    return this.tools.draft(dto);
  }

  @Post('knowledge/reorder')
  async reorder(@CurrentUser() user: AuthenticatedUser, @Body() dto: ReorderKnowledgeDto) {
    await this.knowledge.reorder(dto.ids, user.id);
    return { ok: true };
  }

  @Post('knowledge')
  createKnowledge(@CurrentUser() user: AuthenticatedUser, @Body() dto: KnowledgeBodyDto) {
    return this.knowledge.create(dto, user.id);
  }

  @Get('knowledge/:id')
  getKnowledge(@Param('id') id: string) {
    return this.knowledge.getOne(id);
  }

  @Patch('knowledge/:id')
  updateKnowledge(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: KnowledgeBodyDto) {
    return this.knowledge.update(id, dto, user.id);
  }

  @Delete('knowledge/:id')
  async removeKnowledge(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    await this.knowledge.remove(id, user.id);
    return { ok: true };
  }

  @Post('knowledge/:id/restore')
  restoreKnowledge(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: RestoreKnowledgeDto) {
    return this.knowledge.restore(id, dto.revisionId, user.id);
  }

  @Post('knowledge/:id/reset')
  resetKnowledge(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.knowledge.resetToDefault(id, user.id);
  }

  @Get('limits')
  limits() {
    return this.overview.limits();
  }

  @Put('limits')
  updateLimits(@CurrentUser() user: AuthenticatedUser, @Body() dto: UpdateLimitsDto) {
    return this.overview.updateLimits(dto.values, user.id);
  }

  @Get('venue-credit')
  venueCredit(@Query() q: ListVenueCreditDto) {
    return this.credit.list(q.q);
  }

  @Get('venues/:venueId/credit')
  venueCreditDetail(@Param('venueId') venueId: string) {
    return this.credit.detail(venueId);
  }

  @Patch('venues/:venueId/credit')
  updateVenueCredit(@CurrentUser() user: AuthenticatedUser, @Param('venueId') venueId: string, @Body() dto: UpdateVenueCreditDto) {
    return this.credit.update(user.id, venueId, dto);
  }

  @Post('venues/:venueId/credit/top-ups')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  topUpVenueCredit(@CurrentUser() user: AuthenticatedUser, @Param('venueId') venueId: string, @Body() dto: AiCreditTopUpDto) {
    return this.credit.topUp(user.id, venueId, dto);
  }

  @Get('quality')
  qualityOverview() {
    return this.quality.overview();
  }

  @Get('quality/runs/:id')
  qualityRun(@Param('id') id: string) {
    return this.quality.getRun(id);
  }

  @Get('quality/jobs/:id')
  qualityJob(@Param('id') id: string) {
    return this.quality.jobStatus(id);
  }

  @Post('quality/run')
  @Throttle({ default: { limit: 4, ttl: 60_000 } })
  startEval(@CurrentUser() user: AuthenticatedUser, @Body() dto: StartEvalDto) {
    return this.quality.startEval(dto, user.id);
  }

  @Post('quality/shadow')
  @Throttle({ default: { limit: 4, ttl: 60_000 } })
  startShadow(@CurrentUser() user: AuthenticatedUser, @Body() dto: StartShadowDto) {
    return this.quality.startShadow(dto, user.id);
  }
}
