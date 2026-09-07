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

function isPrivileged(user: AuthenticatedUser) {
  return user.roles.includes('admin');
}

@ApiTags('venues')
@Controller()
export class VenuesController {
  constructor(
    private readonly venues: VenuesService,
    private readonly storage: StorageService,
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
  @Roles('owner', 'admin')
  @Get('owner/venues')
  listMine(@CurrentUser() user: AuthenticatedUser) {
    return this.venues.listMine(user.id);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('owner', 'admin')
  @Patch('owner/venues/:id')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateVenueDto,
  ) {
    return this.venues.update(id, user.id, isPrivileged(user), dto);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('owner', 'admin')
  @Post('owner/venues/:id/photos')
  @UseInterceptors(FileInterceptor('photo', IMAGE_UPLOAD_OPTIONS))
  async addPhoto(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @UploadedFile() file: MulterFile,
  ) {
    if (!file?.buffer) throw new BadRequestException('photo file is required');
    const uploaded = await this.storage.uploadBuffer(
      file.buffer,
      file.originalname,
      file.mimetype,
      'venues',
    );
    return this.venues.addPhoto(id, user.id, isPrivileged(user), uploaded.url);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('owner', 'admin')
  @Patch('owner/venues/:id/photos/reorder')
  reorderPhotos(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body('orderedIds') orderedIds: string[],
  ) {
    return this.venues.reorderPhotos(
      id,
      user.id,
      isPrivileged(user),
      orderedIds,
    );
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('owner', 'admin')
  @Delete('owner/venues/:id/photos/:photoId')
  async deletePhoto(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Param('photoId') photoId: string,
  ) {
    const photo = await this.venues.deletePhoto(
      id,
      photoId,
      user.id,
      isPrivileged(user),
    );
    const key = this.storage.keyFromUrl(photo.url);
    if (key) await this.storage.deleteObject(key);
    return { deleted: true, id: photo.id };
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('owner', 'admin')
  @Post('owner/venues/:id/courts')
  addCourt(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: CreateCourtDto,
  ) {
    return this.venues.addCourt(id, user.id, isPrivileged(user), dto);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('owner', 'admin')
  @Patch('owner/courts/:courtId')
  updateCourt(
    @CurrentUser() user: AuthenticatedUser,
    @Param('courtId') courtId: string,
    @Body() dto: UpdateCourtDto,
  ) {
    return this.venues.updateCourt(courtId, user.id, isPrivileged(user), dto);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('owner', 'admin')
  @Delete('owner/courts/:courtId')
  deleteCourt(
    @CurrentUser() user: AuthenticatedUser,
    @Param('courtId') courtId: string,
  ) {
    return this.venues.deleteCourt(courtId, user.id, isPrivileged(user));
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('owner', 'admin')
  @Post('owner/courts/:courtId/pricing-rules')
  addPricingRule(
    @CurrentUser() user: AuthenticatedUser,
    @Param('courtId') courtId: string,
    @Body() dto: UpsertPricingRuleDto,
  ) {
    return this.venues.addPricingRule(
      courtId,
      user.id,
      isPrivileged(user),
      dto,
    );
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('owner', 'admin')
  @Patch('owner/pricing-rules/:ruleId')
  updatePricingRule(
    @CurrentUser() user: AuthenticatedUser,
    @Param('ruleId') ruleId: string,
    @Body() dto: UpsertPricingRuleDto,
  ) {
    return this.venues.updatePricingRule(
      ruleId,
      user.id,
      isPrivileged(user),
      dto,
    );
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('owner', 'admin')
  @Delete('owner/pricing-rules/:ruleId')
  deletePricingRule(
    @CurrentUser() user: AuthenticatedUser,
    @Param('ruleId') ruleId: string,
  ) {
    return this.venues.deletePricingRule(ruleId, user.id, isPrivileged(user));
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
