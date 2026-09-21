import {
  BadRequestException,
  Body,
  Controller,
  NotFoundException,
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
import { RequirePermission } from '../../common/decorators/permissions.decorator';
import { requireStaffVenue } from '../../common/access/actor-access';
import { PrismaService } from '../prisma/prisma.service';
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
  constructor(
    private readonly rewards: RewardsService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Who a promo-code action runs as. Staff act as the owner they work for, and only
   * on a venue in their list (a promo without a venue is platform-wide: admin only).
   */
  private async promoActor(
    user: AuthenticatedUser,
    venueId?: string | null,
  ): Promise<{ userId: string; isAdmin: boolean }> {
    if (user.roles.includes('admin')) return { userId: user.id, isAdmin: true };
    if (user.roles.includes('owner')) return { userId: user.id, isAdmin: false };
    if (!venueId) throw new BadRequestException('venueId is required');
    const scope = await requireStaffVenue(this.prisma, user, venueId);
    return { userId: scope.ownerId, isAdmin: false };
  }

  private async promoVenueId(id: string): Promise<string | null> {
    const promo = await this.prisma.promoCode.findUnique({ where: { id }, select: { venueId: true } });
    if (!promo) throw new NotFoundException('Promo code not found');
    return promo.venueId;
  }

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
  @Roles('admin', 'owner', 'staff')
  @RequirePermission('promotions.manage')
  @Post('promo-codes')
  async createPromo(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreatePromoCodeDto,
  ) {
    const actor = await this.promoActor(user, dto.venueId);
    return this.rewards.createPromoCode(actor.userId, dto, actor.isAdmin);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('admin', 'owner', 'staff')
  @RequirePermission('promotions.manage')
  @Get('promo-codes')
  async listPromo(
    @CurrentUser() user: AuthenticatedUser,
    @Query('venueId') venueId?: string,
  ) {
    const actor = await this.promoActor(user, venueId);
    return this.rewards.listPromoCodes(actor.userId, actor.isAdmin, venueId);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('admin', 'owner', 'staff')
  @RequirePermission('promotions.manage')
  @Patch('promo-codes/:id')
  async setPromoActive(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdatePromoCodeDto,
  ) {
    const actor = await this.promoActor(user, await this.promoVenueId(id));
    return this.rewards.updatePromoCode(id, actor.userId, actor.isAdmin, dto);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('admin', 'owner', 'staff')
  @RequirePermission('promotions.manage')
  @Delete('promo-codes/:id')
  async deactivatePromo(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    const actor = await this.promoActor(user, await this.promoVenueId(id));
    return this.rewards.deactivatePromoCode(id, actor.userId, actor.isAdmin);
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
