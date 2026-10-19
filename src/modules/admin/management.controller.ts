import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '../../common/guards/auth.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.interface';
import { ManagementService } from './management.service';
import {
  AdminReviewDto,
  AdminUserDto,
  AdminVenueDto,
  AdminVenueListingDto,
  AdminVenueStatusDto,
  CoinAdjustmentDto,
  ManagementQuery,
  ReasonDto,
} from './dto/management.dto';
import { BookingsService } from '../bookings/bookings.service';
import { RealtimeGatewayEmitter } from '../realtime/realtime-emitter.interface';
import { VenueListingService } from '../venues/venue-listing.service';

@Controller('admin/manage')
@UseGuards(AuthGuard)
@Roles('admin')
export class ManagementController {
  constructor(
    private readonly management: ManagementService,
    private readonly bookings: BookingsService,
    private readonly emitter: RealtimeGatewayEmitter,
    private readonly listing: VenueListingService,
  ) {}
  @Get('users') users(@Query() q: ManagementQuery) {
    return this.management.users(q);
  }
  @Get('users/:id') user(@Param('id') id: string) {
    return this.management.user(id);
  }
  @Get('users/:id/assistant-messages') assistantMessages(
    @Param('id') id: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.management.assistantMessages(id, limit ? Number(limit) : undefined, cursor);
  }
  @Get('users/:id/captain-questions') captainQuestions(
    @Param('id') id: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.management.captainQuestions(id, limit ? Number(limit) : undefined, cursor);
  }
  @Patch('users/:id') async updateUser(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: AdminUserDto,
  ) {
    const saved = await this.management.updateUser(u.id, id, dto);
    this.emitter.emitToUser(id, { type: 'rewards.account.updated' });
    return saved;
  }
  @Post('users/:id/coins') async coins(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: CoinAdjustmentDto,
  ) {
    const saved = await this.management.coins(u.id, id, dto);
    this.emitter.emitToUser(id, { type: 'rewards.balance.updated' });
    return saved;
  }
  @Get('venues') venues(@Query() q: ManagementQuery) {
    return this.management.venues(q);
  }
  @Get('venues/:id') async venue(@Param('id') id: string) {
    const venue = await this.management.venue(id);
    return { ...venue, visibility: await this.listing.stateOf(venue.id) };
  }
  /** Current listing / moderation state with the reason, actor and time. */
  @Get('venues/:id/visibility') visibility(@Param('id') id: string) {
    return this.listing.stateOf(id);
  }
  /** Hide or show a venue on Matchena. Does not touch the owner's own preference. */
  @Patch('venues/:id/listing') setListing(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: AdminVenueListingDto,
  ) {
    return this.listing.adminSetListing(u.id, id, dto.hidden, dto.reason.trim());
  }
  /** Approve, send back to review or suspend. Suspension always beats the owner. */
  @Patch('venues/:id/status') async setStatus(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: AdminVenueStatusDto,
  ) {
    await this.management.updateVenue(u.id, id, {
      status: dto.status,
      reason: dto.reason,
      force: dto.force,
    });
    return this.listing.stateOf(id);
  }
  @Patch('venues/:id') updateVenue(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: AdminVenueDto,
  ) {
    return this.management.updateVenue(u.id, id, dto);
  }
  @Patch('reviews/:id') review(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: AdminReviewDto,
  ) {
    return this.management.updateReview(u.id, id, dto);
  }
  @Get('bookings') listBookings(@Query() q: ManagementQuery) {
    return this.management.bookings(q);
  }
  @Get('bookings/:id') booking(@Param('id') id: string) {
    return this.management.booking(id);
  }
  @Post('bookings/:id/cancel') cancel(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ReasonDto,
  ) {
    return this.bookings.cancelByAdmin(u.id, id, dto.reason);
  }
}
