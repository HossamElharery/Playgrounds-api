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
import { UpdatePromoCodeDto } from './dto/update-promo-code.dto';
import { CreateQuestDto } from './dto/create-quest.dto';
import { UpdateQuestDto } from './dto/update-quest.dto';
import { CreateBadgeDto } from './dto/create-badge.dto';
import { UpdateBadgeDto } from './dto/update-badge.dto';
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
  @Post('rewards/streak-freeze/purchase')
  purchaseStreakFreeze(@CurrentUser() user: AuthenticatedUser) {
    return this.rewards.purchaseStreakFreeze(user.id);
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
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Query('sportId') sportId?: string,
    @Query('scope') scope: 'weekly' | 'monthly' = 'weekly',
    @Query('districtId') districtId?: string,
    @Query('friendsOnly') friendsOnly?: string,
  ) {
    const friendsUserId = friendsOnly === 'true' ? user?.id : undefined;
    return this.rewards.leaderboard(sportId, scope, districtId, friendsUserId);
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
    @Body() dto: UpdatePromoCodeDto,
  ) {
    return this.rewards.updatePromoCode(
      id,
      user.id,
      user.roles.includes('admin'),
      dto,
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
  @Get('admin/quests')
  listQuests() {
    return this.rewards.listQuestDefinitions();
  }

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
  @Patch('admin/quests/:id')
  updateQuest(@Param('id') id: string, @Body() dto: UpdateQuestDto) {
    return this.rewards.updateQuest(id, dto);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('admin')
  @Get('admin/badges')
  listBadges() {
    return this.rewards.listBadgeDefinitions();
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
  @Patch('admin/badges/:id')
  updateBadge(@Param('id') id: string, @Body() dto: UpdateBadgeDto) {
    return this.rewards.updateBadge(id, dto);
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
