import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../../common/guards/auth.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { OwnerOnly } from '../../common/decorators/permissions.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.interface';
import { SubscriptionsService } from './subscriptions.service';
import { ExtendSubscriptionDto, UpdateSubscriptionTermsDto, UpdateTrialDaysDto } from './dto/subscription.dto';

@ApiTags('subscriptions')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller()
export class SubscriptionsController {
  constructor(private readonly subscriptions: SubscriptionsService) {}

  /** Trial length and billing terms for the website's pricing pages. */
  @Public()
  @Get('subscriptions/terms')
  publicTerms() {
    return this.subscriptions.publicTerms();
  }

  @Roles('admin')
  @Patch('admin/subscriptions/terms')
  setTrialDays(@CurrentUser() admin: AuthenticatedUser, @Body() dto: UpdateTrialDaysDto) {
    return this.subscriptions.setTrialDays(admin, dto.trialDays);
  }

  @Roles('owner', 'admin')
  @OwnerOnly()
  @Get('owner/subscription')
  mine(@CurrentUser() user: AuthenticatedUser, @Query('venueId') venueId: string) {
    return this.subscriptions.forOwner(user, venueId);
  }

  @Roles('admin')
  @Get('admin/subscriptions')
  list(@Query('state') state?: string, @Query('q') q?: string) {
    return this.subscriptions.listAdmin({ state, q });
  }

  @Roles('admin')
  @Get('admin/venues/:venueId/subscription')
  one(@Param('venueId') venueId: string) {
    return this.subscriptions.forAdmin(venueId);
  }

  @Roles('admin')
  @Patch('admin/venues/:venueId/subscription')
  terms(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('venueId') venueId: string,
    @Body() dto: UpdateSubscriptionTermsDto,
  ) {
    return this.subscriptions.updateTerms(admin, venueId, dto);
  }

  @Roles('admin')
  @Post('admin/venues/:venueId/subscription/extend')
  extend(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('venueId') venueId: string,
    @Body() dto: ExtendSubscriptionDto,
  ) {
    return this.subscriptions.extend(admin, venueId, dto);
  }
}
