import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
  UploadedFile,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../../common/guards/auth.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.interface';
import type { MulterFile } from '../../common/types/multer-file.type';
import { VenuesService } from './venues.service';
import { StorageService } from '../storage/storage.service';
import { CreateVenueDto } from './dto/create-venue.dto';
import { UpdateVenueDto } from './dto/update-venue.dto';
import { SearchVenuesDto } from './dto/search-venues.dto';
import { CreateCourtDto, UpdateCourtDto } from './dto/court.dto';
import { UpsertPricingRuleDto } from './dto/pricing-rule.dto';
import { IMAGE_UPLOAD_OPTIONS } from '../../common/uploads/image-upload';
import { RequireAnyPermission, RequirePermission } from '../../common/decorators/permissions.decorator';
import {
  actingOwnerId,
  venueActorPrivilege,
  venueIdOfCourt,
  venueIdOfPricingRule,
} from '../../common/access/actor-access';
import { loadStaffScope } from '../../common/access/staff-scope';
import { PrismaService } from '../prisma/prisma.service';

@ApiTags('venues')
@Controller()
export class VenuesController {
  constructor(
    private readonly venues: VenuesService,
    private readonly storage: StorageService,
    private readonly prisma: PrismaService,
  ) {}

  @Public()
  @Get('venues/search')
  async searchExplore(@Query() query: SearchVenuesDto) {
    return this.venues.searchExplore(query);
  }

  @Public()
  @Get('venues/search/count')
  async searchCount(@Query() query: SearchVenuesDto) {
    const result = await this.venues.searchExplore({
      ...query,
      include: 'count',
    });
    return { count: result.count };
  }

  @Public()
  @Get('venues')
  async search(@Query() query: SearchVenuesDto) {
    const { items, pagination } = await this.venues.search(query);
    return { message: 'ok', result: items, pagination };
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Post('venues/:id/favorite')
  favorite(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.venues.favorite(user.id, id);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Delete('venues/:id/favorite')
  unfavorite(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.venues.unfavorite(user.id, id);
  }

  @Public()
  @Get('venues/:slug')
  getBySlug(@Param('slug') slug: string) {
    return this.venues.getBySlug(slug);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('owner')
  @Post('owner/venues')
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateVenueDto) {
    return this.venues.create(user.id, dto);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('owner', 'staff', 'admin')
  @RequireAnyPermission(
    'bookings.view', 'venue.manage', 'pricing.manage', 'promotions.manage',
    'tournaments.manage', 'reviews.reply', 'reports.view', 'account.view', 'team.manage',
  )
  @Get('owner/venues')
  async listMine(@CurrentUser() user: AuthenticatedUser) {
    if (!user.roles.includes('owner') && user.roles.includes('staff')) {
      const scope = await loadStaffScope(this.prisma, user.id);
      return scope ? this.venues.listMine(scope.ownerId, scope.venueIds) : [];
    }
    return this.venues.listMine(user.id);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('owner', 'staff', 'admin')
  @RequireAnyPermission('venue.manage', 'pricing.manage')
  @Get('owner/venues/:id')
  async ownedDetail(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    const privileged = await venueActorPrivilege(this.prisma, user, id);
    return this.venues.getOwnedDetail(id, await actingOwnerId(this.prisma, user), privileged);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('owner', 'staff', 'admin')
  @RequirePermission('venue.manage')
  @Patch('owner/venues/:id')
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateVenueDto,
  ) {
    return this.venues.update(id, await actingOwnerId(this.prisma, user), await venueActorPrivilege(this.prisma, user, id), dto);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('owner', 'staff', 'admin')
  @RequirePermission('venue.manage')
  @Post('owner/venues/:id/photos')
  @UseInterceptors(FileInterceptor('photo', IMAGE_UPLOAD_OPTIONS))
  async addPhoto(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @UploadedFile() file: MulterFile,
  ) {
    if (!file?.buffer) throw new BadRequestException('photo file is required');
    const privileged = await venueActorPrivilege(this.prisma, user, id);
    const uploaded = await this.storage.uploadBuffer(
      file.buffer,
      file.originalname,
      file.mimetype,
      'venues',
    );
    return this.venues.addPhoto(id, await actingOwnerId(this.prisma, user), privileged, uploaded.url);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('owner', 'staff', 'admin')
  @RequirePermission('venue.manage')
  @Patch('owner/venues/:id/photos/reorder')
  async reorderPhotos(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body('orderedIds') orderedIds: string[],
  ) {
    return this.venues.reorderPhotos(
      id,
      await actingOwnerId(this.prisma, user),
      await venueActorPrivilege(this.prisma, user, id),
      orderedIds,
    );
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('owner', 'staff', 'admin')
  @RequirePermission('venue.manage')
  @Delete('owner/venues/:id/photos/:photoId')
  async deletePhoto(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Param('photoId') photoId: string,
  ) {
    const photo = await this.venues.deletePhoto(
      id,
      photoId,
      await actingOwnerId(this.prisma, user),
      await venueActorPrivilege(this.prisma, user, id),
    );
    const key = this.storage.keyFromUrl(photo.url);
    if (key) await this.storage.deleteObject(key);
    return { deleted: true, id: photo.id };
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('owner', 'staff', 'admin')
  @RequirePermission('venue.manage')
  @Post('owner/venues/:id/courts')
  async addCourt(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: CreateCourtDto,
  ) {
    return this.venues.addCourt(id, await actingOwnerId(this.prisma, user), await venueActorPrivilege(this.prisma, user, id), dto);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('owner', 'staff', 'admin')
  @RequirePermission('venue.manage')
  @Patch('owner/courts/:courtId')
  async updateCourt(
    @CurrentUser() user: AuthenticatedUser,
    @Param('courtId') courtId: string,
    @Body() dto: UpdateCourtDto,
  ) {
    const venueId = await venueIdOfCourt(this.prisma, courtId);
    return this.venues.updateCourt(courtId, await actingOwnerId(this.prisma, user), await venueActorPrivilege(this.prisma, user, venueId), dto);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('owner', 'staff', 'admin')
  @RequirePermission('venue.manage')
  @Delete('owner/courts/:courtId')
  async deleteCourt(
    @CurrentUser() user: AuthenticatedUser,
    @Param('courtId') courtId: string,
  ) {
    const venueId = await venueIdOfCourt(this.prisma, courtId);
    return this.venues.deleteCourt(courtId, await actingOwnerId(this.prisma, user), await venueActorPrivilege(this.prisma, user, venueId));
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('owner', 'staff', 'admin')
  @RequirePermission('pricing.manage')
  @Post('owner/courts/:courtId/pricing-rules')
  async addPricingRule(
    @CurrentUser() user: AuthenticatedUser,
    @Param('courtId') courtId: string,
    @Body() dto: UpsertPricingRuleDto,
  ) {
    const venueId = await venueIdOfCourt(this.prisma, courtId);
    return this.venues.addPricingRule(
      courtId,
      await actingOwnerId(this.prisma, user),
      await venueActorPrivilege(this.prisma, user, venueId),
      dto,
    );
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('owner', 'staff', 'admin')
  @RequirePermission('pricing.manage')
  @Patch('owner/pricing-rules/:ruleId')
  async updatePricingRule(
    @CurrentUser() user: AuthenticatedUser,
    @Param('ruleId') ruleId: string,
    @Body() dto: UpsertPricingRuleDto,
  ) {
    const venueId = await venueIdOfPricingRule(this.prisma, ruleId);
    return this.venues.updatePricingRule(
      ruleId,
      await actingOwnerId(this.prisma, user),
      await venueActorPrivilege(this.prisma, user, venueId),
      dto,
    );
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('owner', 'staff', 'admin')
  @RequirePermission('pricing.manage')
  @Delete('owner/pricing-rules/:ruleId')
  async deletePricingRule(
    @CurrentUser() user: AuthenticatedUser,
    @Param('ruleId') ruleId: string,
  ) {
    const venueId = await venueIdOfPricingRule(this.prisma, ruleId);
    return this.venues.deletePricingRule(ruleId, await actingOwnerId(this.prisma, user), await venueActorPrivilege(this.prisma, user, venueId));
  }

  // ---- Admin ----
  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('admin')
  @Get('admin/venues/pending')
  listPending() {
    return this.venues.listPendingApproval();
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('admin')
  @Post('admin/venues/:id/approve')
  approve(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.venues.approve(user.id, id);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('admin')
  @Post('admin/venues/:id/suspend')
  suspend(@Param('id') id: string) {
    return this.venues.setStatus(id, 'suspended');
  }
}
