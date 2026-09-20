import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthGuard } from '../../common/guards/auth.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.interface';
import { OwnerService } from './owner.service';
import { CreateStaffInviteDto } from './dto/staff-invite.dto';
import { CreateWalkInDto } from './dto/walk-in.dto';
import {
  CreateAssistantMessageDto,
  CreateCalendarBlockDto,
  CreatePayoutMethodDto,
  InterpretScheduleCommandDto,
  OwnerBookingActionDto,
  UndoAssistantMessageDto,
  VerifyVenueQrDto,
} from './dto/owner-operations.dto';
import { SetStaffStatusDto } from './dto/status-actions.dto';
import { BookingsService } from '../bookings/bookings.service';
import { OwnerBookingsService } from './owner-bookings.service';
import { OwnerSummaryService } from './owner-summary.service';
import {
  AddManualPaymentDto,
  CreateManualBookingDto,
  OwnerRemittanceDto,
  OwnerSummaryQueryDto,
  UpdateManualBookingDto,
} from './dto/manual-booking.dto';
import { ApiException } from '../../common/errors/api-exception';

@ApiTags('owner')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Roles('owner', 'staff', 'admin')
@Controller('owner')
export class OwnerController {
  constructor(
    private readonly owner: OwnerService,
    private readonly bookings: BookingsService,
    private readonly ownerBookings: OwnerBookingsService,
    private readonly summary: OwnerSummaryService,
  ) {}

  @Get('overview')
  overview(@CurrentUser() user: AuthenticatedUser) {
    return this.owner.overview(user.id);
  }

  @Get('calendar')
  calendar(
    @CurrentUser() user: AuthenticatedUser,
    @Query('venueId') venueId: string,
    @Query('date') date: string,
  ) {
    return this.owner.calendar(user, venueId, date);
  }

  @Get('board')
  board(
    @CurrentUser() user: AuthenticatedUser,
    @Query('venueId') venueId: string,
    @Query('date') date: string,
  ) {
    return this.owner.board(user, venueId, date);
  }

  // Costs a real Gemini call per request — throttled well under the global
  // limit so a runaway client can't burn through the owner's AI budget.
  @Throttle({ default: { limit: 15, ttl: 60_000 } })
  @Post('assistant/interpret')
  interpretAssistant(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: InterpretScheduleCommandDto,
  ) {
    return this.owner.interpretScheduleCommand(user, dto.venueId, dto.text);
  }

  @Get('assistant/messages')
  listAssistantMessages(
    @CurrentUser() user: AuthenticatedUser,
    @Query('venueId') venueId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.owner.listAssistantMessages(
      user,
      venueId,
      limit ? Number(limit) : undefined,
      cursor,
    );
  }

  @Post('assistant/messages')
  createAssistantMessage(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateAssistantMessageDto,
  ) {
    return this.owner.createAssistantMessage(user, dto);
  }

  @Post('assistant/undo')
  undoAssistantMessage(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UndoAssistantMessageDto,
  ) {
    return this.owner.undoAssistantMessage(user, dto.venueId, dto.messageId);
  }

  @Post('calendar/walk-in')
  @ApiOperation({ summary: 'Deprecated: use POST /owner/bookings/manual', deprecated: true })
  walkIn(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateWalkInDto,
  ) {
    return this.ownerBookings.createWalkInAlias(user, dto);
  }

  @Post('calendar/blocks')
  createBlock(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateCalendarBlockDto,
  ) {
    return this.owner.createCalendarBlock(user, dto);
  }

  @Delete('calendar/blocks/:id')
  deleteBlock(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.owner.deleteCalendarBlock(user, id);
  }

  @Get('finance')
  finance(
    @CurrentUser() user: AuthenticatedUser,
    @Query('venueId') venueId: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    return this.owner.finance(user, venueId, from, to);
  }

  @Get('finance/export')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  async financeExport(
    @CurrentUser() user: AuthenticatedUser,
    @Query('venueId') venueId: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    const csv = await this.summary.exportCsv(user, venueId, from, to);
    return new StreamableFile(Buffer.from(csv, 'utf8'), {
      type: 'text/csv; charset=utf-8',
      disposition: `attachment; filename="matchena-finance-${venueId}.csv"`,
    });
  }

  @Get('customers')
  customers(
    @CurrentUser() user: AuthenticatedUser,
    @Query('venueId') venueId: string,
  ) {
    return this.owner.customers(user, venueId);
  }

  @Post('staff-invites')
  inviteStaff(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateStaffInviteDto,
  ) {
    return this.owner.inviteStaff(user, dto);
  }

  @Get('staff-invites')
  listStaffInvites(
    @CurrentUser() user: AuthenticatedUser,
    @Query('venueId') venueId: string,
  ) {
    return this.owner.listStaffInvites(user, venueId);
  }

  @Post('staff-invites/:id/accept')
  acceptInvite(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.owner.acceptStaffInvite(user.id, id);
  }

  @Post('staff-invites/:id/revoke')
  revokeInvite(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.owner.revokeStaffInvite(user, id);
  }

  @Patch('staff-invites/:id')
  setStaffStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: SetStaffStatusDto,
  ) {
    return this.owner.setStaffStatus(user, id, dto.status);
  }

  @Get('payout-methods')
  listPayouts(@CurrentUser() user: AuthenticatedUser) {
    return this.owner.listPayoutMethods(user.id);
  }

  @Post('payout-methods')
  createPayout(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreatePayoutMethodDto,
  ) {
    return this.owner.createPayoutMethod(user.id, dto);
  }

  @Delete('payout-methods/:id')
  deletePayout(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.owner.deletePayoutMethod(user.id, id);
  }

  @Post('bookings/manual')
  @ApiOperation({ summary: 'Create a manual (walk-in / phone / WhatsApp) booking' })
  createManual(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateManualBookingDto,
  ) {
    return this.ownerBookings.createManualBooking(user, dto);
  }

  @Patch('bookings/:id')
  @ApiOperation({ summary: 'Update a manual booking (platform bookings are locked)' })
  updateManual(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateManualBookingDto,
  ) {
    return this.ownerBookings.updateManualBooking(user, id, dto);
  }

  @Delete('bookings/:id')
  @ApiOperation({ summary: 'Soft-cancel a manual booking' })
  deleteManual(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.ownerBookings.deleteManualBooking(user, id);
  }

  @Post('bookings/:id/restore')
  @ApiOperation({ summary: 'Restore a cancelled manual booking if the slot is free' })
  restoreManual(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.ownerBookings.restoreManualBooking(user, id);
  }

  @Post('bookings/:id/payments')
  @ApiOperation({ summary: 'Record a later payment on a manual booking' })
  addPayment(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: AddManualPaymentDto,
  ) {
    return this.ownerBookings.addManualPayment(user, id, dto.amount, dto.method);
  }

  @Get('venues/:venueId/booking-sources')
  @ApiOperation({ summary: 'List preset and saved booking sources' })
  listSources(
    @CurrentUser() user: AuthenticatedUser,
    @Param('venueId') venueId: string,
  ) {
    return this.ownerBookings.listSources(user, venueId);
  }

  @Delete('venues/:venueId/booking-sources/:id')
  @ApiOperation({ summary: 'Forget a saved custom source label' })
  deleteSource(
    @CurrentUser() user: AuthenticatedUser,
    @Param('venueId') venueId: string,
    @Param('id') id: string,
  ) {
    return this.ownerBookings.deleteSource(user, venueId, id);
  }

  @Get('summary')
  @ApiOperation({ summary: 'Timezone-correct owner earnings summary' })
  summaryEndpoint(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: OwnerSummaryQueryDto,
  ) {
    if (!query.venueId) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        'MIXED_TIMEZONES_REQUIRE_VENUE',
        'venueId is required',
      );
    }
    return this.summary.getSummary(user, query.venueId, query.range ?? 'today', query.from, query.to);
  }

  @Get('reports/bookings')
  @ApiOperation({ summary: 'Cursor-paginated bookings report' })
  reportBookings(
    @CurrentUser() user: AuthenticatedUser,
    @Query('venueId') venueId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('source') source?: string,
    @Query('status') status?: string,
    @Query('courtId') courtId?: string,
    @Query('paymentStatus') paymentStatus?: string,
    @Query('q') q?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.ownerBookings.listReportBookings(user, {
      venueId,
      from,
      to,
      source,
      status,
      courtId,
      paymentStatus,
      q,
      cursor,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('matchena-account')
  @ApiOperation({ summary: 'Owner Matchena ledger balance (read-only)' })
  matchenaAccount(
    @CurrentUser() user: AuthenticatedUser,
    @Query('venueId') venueId: string,
  ) {
    return this.ownerBookings.getMatchenaAccount(user, venueId);
  }

  @Post('matchena-account/remittances')
  @ApiOperation({ summary: 'Submit a remittance for Matchena to confirm' })
  createRemittance(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: OwnerRemittanceDto,
  ) {
    return this.ownerBookings.createRemittance(user, dto);
  }

  @Delete('matchena-account/remittances/:id')
  @ApiOperation({ summary: 'Cancel a pending remittance' })
  cancelRemittance(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.ownerBookings.cancelRemittance(user, id);
  }

  @Get('attention')
  @ApiOperation({ summary: 'Bookings needing arrival confirmation or unpaid manuals' })
  attention(
    @CurrentUser() user: AuthenticatedUser,
    @Query('venueId') venueId: string,
  ) {
    return this.ownerBookings.attention(user, venueId);
  }

  @Get('price-quote')
  @ApiOperation({ summary: 'Quote a price from the unit pricing rules' })
  priceQuote(
    @CurrentUser() user: AuthenticatedUser,
    @Query('venueId') venueId: string,
    @Query('courtId') courtId: string,
    @Query('startsAt') startsAt: string,
    @Query('durationMinutes') durationMinutes?: string,
  ) {
    return this.ownerBookings.priceQuote(
      user,
      venueId,
      courtId,
      startsAt,
      durationMinutes ? Number(durationMinutes) : 60,
    );
  }

  @Post('bookings/verify-qr')
  verifyQr(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: VerifyVenueQrDto,
  ) {
    return this.bookings.verifyVenueQr(user, dto);
  }

  @Post('bookings/:id/no-show')
  markNoShow(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.bookings.markNoShow(user, id);
  }

  @Post('bookings/:id/cancel')
  ownerCancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: OwnerBookingActionDto,
  ) {
    return this.bookings.ownerCancel(user, id, dto.reason);
  }

  @Post('bookings/:id/checkin')
  ownerCheckIn(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.bookings.checkInById(user, id);
  }
}
