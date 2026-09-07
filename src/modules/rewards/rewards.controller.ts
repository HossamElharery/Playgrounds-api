import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../../common/guards/auth.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.interface';
import { RewardsService } from './rewards.service';
import { CreatePromoCodeDto } from './dto/create-promo-code.dto';
import { SetPromoActiveDto } from '../owner/dto/status-actions.dto';
import { CreateQuestDto } from './dto/create-quest.dto';
import { CreateBadgeDto } from './dto/create-badge.dto';
import { UpdatePlatformSettingDto } from './dto/update-platform-setting.dto';

@ApiTags('rewards')
@Controller()
export class RewardsController {
  constructor(private readonly rewards: RewardsService) {}

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Get('rewards/wallet')
  wallet(@CurrentUser() user: AuthenticatedUser) {
    return this.rewards.wallet(user.id);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Post('rewards/checkin')
  checkIn(@CurrentUser() user: AuthenticatedUser) {
    return this.rewards.dailyCheckIn(user.id);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Get('rewards/quests')
  quests(@CurrentUser() user: AuthenticatedUser) {
    return this.rewards.myQuests(user.id);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Get('rewards/badges')
  badges(@CurrentUser() user: AuthenticatedUser) {
    return this.rewards.myBadges(user.id);
  }

  @Public()
  @Get('leaderboards')
  leaderboard(
    @Query('sportId') sportId?: string,
    @Query('scope') scope: 'weekly' | 'monthly' = 'weekly',
    @Query('districtId') districtId?: string,
  ) {
    return this.rewards.leaderboard(sportId, scope, districtId);
  }

  // ---- Promo codes ----
  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('admin', 'owner')
  @Post('promo-codes')
  createPromo(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreatePromoCodeDto,
  ) {
    return this.rewards.createPromoCode(
      user.id,
      dto,
      user.roles.includes('admin'),
    );
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('admin', 'owner')
  @Get('promo-codes')
  listPromo(
    @CurrentUser() user: AuthenticatedUser,
    @Query('venueId') venueId?: string,
  ) {
    return this.rewards.listPromoCodes(
      user.id,
      user.roles.includes('admin'),
      venueId,
    );
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('admin', 'owner')
  @Patch('promo-codes/:id')
  setPromoActive(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: SetPromoActiveDto,
  ) {
    return this.rewards.setPromoActive(
      id,
      user.id,
      user.roles.includes('admin'),
      dto.active,
    );
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('admin', 'owner')
  @Delete('promo-codes/:id')
  deactivatePromo(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.rewards.deactivatePromoCode(
      id,
      user.id,
      user.roles.includes('admin'),
    );
  }

  // ---- Admin config ----
  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('admin')
  @Post('admin/quests')
  createQuest(@Body() dto: CreateQuestDto) {
    return this.rewards.createQuest(dto);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('admin')
  @Post('admin/badges')
  createBadge(@Body() dto: CreateBadgeDto) {
    return this.rewards.createBadgeDef(dto);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('admin')
  @Get('admin/platform-settings')
  getSettings() {
    return this.rewards.getPlatformSetting();
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('admin')
  @Patch('admin/platform-settings')
  updateSettings(@Body() dto: UpdatePlatformSettingDto) {
    return this.rewards.updatePlatformSetting(dto);
  }
}
