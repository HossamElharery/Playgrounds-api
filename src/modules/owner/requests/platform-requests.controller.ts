import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { AuthGuard } from '../../../common/guards/auth.guard';
import { Roles } from '../../../common/decorators/roles.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.interface';
import { VenueHealthService } from '../health/venue-health.service';
import { PlatformRequestsService } from './platform-requests.service';

class ReplyDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reply?: string;
}

/** Platform admin only — the owner side of these requests lives in `OwnerController`. */
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Roles('admin')
@Controller('admin/platform-requests')
export class PlatformRequestsController {
  constructor(private readonly requests: PlatformRequestsService) {}

  @Get()
  list(@Query('status') status?: string, @Query('venueId') venueId?: string) {
    return this.requests.listAdmin({ status, venueId });
  }

  @Post(':id/approve-cancel')
  approve(@CurrentUser() u: AuthenticatedUser, @Param('id') id: string, @Body() dto: ReplyDto) {
    return this.requests.approveCancel(u.id, id, dto.reply);
  }

  @Post(':id/decline')
  decline(@CurrentUser() u: AuthenticatedUser, @Param('id') id: string, @Body() dto: ReplyDto) {
    return this.requests.decline(u.id, id, dto.reply ?? '');
  }

  @Post(':id/answer')
  answer(@CurrentUser() u: AuthenticatedUser, @Param('id') id: string, @Body() dto: ReplyDto) {
    return this.requests.answer(u.id, id, dto.reply ?? '');
  }

  @Post(':id/close')
  close(@CurrentUser() u: AuthenticatedUser, @Param('id') id: string) {
    return this.requests.close(u.id, id);
  }
}

/** Admin-only overview of every real venue: activity, subscription, onboarding, open requests. */
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Roles('admin')
@Controller('admin/venue-health')
export class VenueHealthController {
  constructor(private readonly health: VenueHealthService) {}

  @Get()
  board() {
    return this.health.board();
  }
}
