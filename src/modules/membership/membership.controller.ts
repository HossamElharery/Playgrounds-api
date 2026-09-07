import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { IsBoolean, IsString } from 'class-validator';
import { AuthGuard } from '../../common/guards/auth.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.interface';
import { MembershipService } from './membership.service';
import {
  CreateMembershipPlanDto,
  SubscribeMembershipDto,
  UpdateMembershipPlanDto,
} from './dto/membership.dto';

class RenewalWebhookDto {
  @IsString()
  userId!: string;

  @IsBoolean()
  success!: boolean;
}

@ApiTags('membership')
@Controller('membership')
export class MembershipController {
  constructor(
    private readonly membership: MembershipService,
    private readonly config: ConfigService,
  ) {}

  @Public()
  @Get('plans')
  listPlans() {
    return this.membership.listPlans();
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('admin')
  @Get('plans/admin')
  listPlansAdmin(@Query('includeInactive') includeInactive?: string) {
    return this.membership.listPlans(includeInactive === 'true');
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('admin')
  @Post('plans')
  createPlan(@Body() dto: CreateMembershipPlanDto) {
    return this.membership.createPlan(dto);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('admin')
  @Patch('plans/:id')
  updatePlan(@Param('id') id: string, @Body() dto: UpdateMembershipPlanDto) {
    return this.membership.updatePlan(id, dto);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('player', 'owner', 'admin')
  @Get('me')
  me(@CurrentUser() user: AuthenticatedUser) {
    return this.membership.me(user.id);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('player', 'owner', 'admin')
  @Post('subscribe')
  subscribe(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: SubscribeMembershipDto,
  ) {
    return this.membership.subscribe(user.id, dto);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('player', 'owner', 'admin')
  @Post('cancel')
  cancel(@CurrentUser() user: AuthenticatedUser) {
    return this.membership.cancel(user.id);
  }

  // Stand-in for a real PSP webhook (§7.6) — see MembershipService doc.
  // Never trust this endpoint without a real signature check once a PSP is wired in.
  @Public()
  @Post('webhooks/renewal')
  webhookRenewal(
    @Headers('x-webhook-secret') secret: string | undefined,
    @Body() dto: RenewalWebhookDto,
  ) {
    const expected = this.config.get<string>('MEMBERSHIP_WEBHOOK_SECRET');
    if (!expected || secret !== expected) {
      throw new UnauthorizedException('Invalid webhook secret');
    }
    return this.membership.handleRenewalWebhook(dto.userId, dto.success);
  }
}
