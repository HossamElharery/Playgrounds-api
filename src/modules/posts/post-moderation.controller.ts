import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../../common/guards/auth.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.interface';
import { PostModerationService } from './post-moderation.service';
import {
  ListModerationReportsQueryDto,
  ModerationReasonDto,
  SuspendPostingDto,
  UpdateCoinsRuleDto,
  UpdateModerationConfigDto,
} from './dto/moderation.dto';
import { CursorPaginationQueryDto } from '../../common/pagination/cursor-pagination.dto';

@ApiTags('admin-moderation')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Roles('admin')
@Controller('admin')
export class PostModerationController {
  constructor(private readonly moderation: PostModerationService) {}

  @Get('moderation/posts/reports')
  reports(@Query() q: ListModerationReportsQueryDto) {
    return this.moderation.reports(q.status, q.q, q.cursor, q.limit);
  }

  @Get('moderation/posts/lookup')
  lookup(@Query('q') q: string) {
    return this.moderation.lookup(q || '');
  }

  @Get('moderation/posts/:id')
  review(@Param('id') id: string) {
    return this.moderation.review(id);
  }

  @Delete('moderation/posts/:id')
  deletePost(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ModerationReasonDto,
  ) {
    return this.moderation.deletePost(user.id, id, dto.reason);
  }

  @Delete('moderation/comments/:id')
  deleteComment(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ModerationReasonDto,
  ) {
    return this.moderation.deleteComment(user.id, id, dto.reason);
  }

  @Post('moderation/reports/:id/dismiss')
  dismiss(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ModerationReasonDto,
  ) {
    return this.moderation.dismiss(user.id, id, dto.reason);
  }

  @Post('moderation/users/:id/suspend-posting')
  suspend(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: SuspendPostingDto,
  ) {
    return this.moderation.suspend(user.id, id, dto);
  }

  @Post('moderation/users/:id/unsuspend-posting')
  unsuspend(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ModerationReasonDto,
  ) {
    return this.moderation.unsuspend(user.id, id, dto.reason);
  }

  @Get('moderation/audit-log')
  audit(@Query() q: CursorPaginationQueryDto) {
    return this.moderation.auditLog(q.cursor, q.limit);
  }

  @Get('coins-rules')
  coinsRules() {
    return this.moderation.coinsRules();
  }

  @Put('coins-rules/:id')
  updateCoins(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateCoinsRuleDto,
  ) {
    return this.moderation.updateCoinsRule(user.id, id, dto);
  }

  @Get('moderation/config')
  config() {
    return this.moderation.config();
  }

  @Put('moderation/config')
  updateConfig(@Body() dto: UpdateModerationConfigDto) {
    return this.moderation.updateConfig(dto);
  }
}
