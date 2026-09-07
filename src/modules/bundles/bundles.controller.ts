import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../../common/guards/auth.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.interface';
import { IdempotencyInterceptor } from '../../common/interceptors/idempotency.interceptor';
import { BundlesService } from './bundles.service';
import {
  CreateBundleDto,
  PurchaseBundleDto,
  UpdateBundleDto,
} from './dto/bundle.dto';

@ApiTags('bundles')
@Controller()
export class BundlesController {
  constructor(private readonly bundles: BundlesService) {}

  @Public()
  @Get('venues/:venueId/bundles')
  listForVenue(@Param('venueId') venueId: string) {
    return this.bundles.listForVenue(venueId);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('owner', 'admin')
  @Post('venues/:venueId/bundles')
  create(
    @Param('venueId') venueId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateBundleDto,
  ) {
    return this.bundles.create(venueId, user, dto);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('owner', 'admin')
  @Patch('bundles/:id')
  update(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateBundleDto,
  ) {
    return this.bundles.update(id, user, dto);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('player', 'owner', 'admin')
  @UseInterceptors(IdempotencyInterceptor)
  @Post('bookings/bundles')
  purchase(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: PurchaseBundleDto,
  ) {
    return this.bundles.purchase(user.id, dto);
  }
}
