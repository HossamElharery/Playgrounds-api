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
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthGuard } from '../../common/guards/auth.guard';
import { AdminEditAuditInterceptor } from '../../common/interceptors/admin-edit-audit.interceptor';
import { Roles } from '../../common/decorators/roles.decorator';
import { AnyStaff, OwnerOnly, RequireAnyPermission, RequirePermission } from '../../common/decorators/permissions.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.interface';
import { OwnerService } from './owner.service';
import { CreateWalkInDto } from './dto/walk-in.dto';
import {
  CreateAssistantMessageDto,
  CreateCalendarBlockDto,
  CreatePayoutMethodDto,
  InterpretScheduleCommandDto,
  OwnerBookingActionDto,
  PlatformChangeRequestDto,
  UndoAssistantMessageDto,
  VerifyVenueQrDto,
} from './dto/owner-operations.dto';
import { BookingsService } from '../bookings/bookings.service';
import { OwnerBookingsService } from './owner-bookings.service';
import { OwnerSummaryService } from './owner-summary.service';
import { FixedBookingsService } from './fixed/fixed-bookings.service';
import {
  CreateFixedSeriesDto,
  FixedSeriesShapeDto,
  RescheduleSeriesDto,
  SeriesDateDto,
} from './fixed/fixed-bookings.dto';
import { PlatformRequestsService } from './requests/platform-requests.service';
import { QuickstartService } from './quickstart/quickstart.service';
import { ExportService } from './exports/export.service';
import { ExpensesService } from './expenses/expenses.service';
import { CreateExpenseDto, UpdateExpenseDto } from './expenses/expenses.dto';
import { InsightsService } from './insights/insights.service';
import { ApplyDiscountDto, OccupancyQueryDto, WindowDto } from './insights/dto/insights.dto';
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
@UseInterceptors(AdminEditAuditInterceptor)
@Controller('owner')
export class OwnerController {
  constructor(
    private readonly owner: OwnerService,
    private readonly bookings: BookingsService,
    private readonly ownerBookings: OwnerBookingsService,
    private readonly summary: OwnerSummaryService,
    private readonly insights: InsightsService,
    private readonly fixed: FixedBookingsService,
    private readonly expenses: ExpensesService,
    private readonly exportCentre: ExportService,
    private readonly platformRequests: PlatformRequestsService,
    private readonly quickstart: QuickstartService,
  ) {}

  @AnyStaff()
  @Get('access')
  access(@CurrentUser() user: AuthenticatedUser) {
    return this.owner.access(user);
  }

  @OwnerOnly()
  @Get('overview')
  overview(@CurrentUser() user: AuthenticatedUser) {
    return this.owner.overview(user.id);
  }

  @RequirePermission('bookings.view')
  @Get('calendar')
  calendar(
    @CurrentUser() user: AuthenticatedUser,
    @Query('venueId') venueId: string,
    @Query('date') date: string,
  ) {
    return this.owner.calendar(user, venueId, date);
  }

  @RequirePermission('bookings.view')
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
  @RequirePermission('schedule.manage')
  @Post('assistant/interpret')
  interpretAssistant(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: InterpretScheduleCommandDto,
  ) {
    return this.owner.interpretScheduleCommand(user, dto.venueId, dto.text);
  }

  @RequirePermission('schedule.manage')
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

  @RequirePermission('schedule.manage')
  @Post('assistant/messages')
  createAssistantMessage(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateAssistantMessageDto,
  ) {
    return this.owner.createAssistantMessage(user, dto);
  }

  @RequirePermission('schedule.manage')
  @Post('assistant/undo')
  undoAssistantMessage(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UndoAssistantMessageDto,
  ) {
    return this.owner.undoAssistantMessage(user, dto.venueId, dto.messageId);
  }

  @RequirePermission('bookings.create')
  @Post('calendar/walk-in')
  @ApiOperation({ summary: 'Deprecated: use POST /owner/bookings/manual', deprecated: true })
  walkIn(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateWalkInDto,
  ) {
    return this.ownerBookings.createWalkInAlias(user, dto);
  }

  @RequirePermission('schedule.manage')
  @Post('calendar/blocks')
  createBlock(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateCalendarBlockDto,
  ) {
    return this.owner.createCalendarBlock(user, dto);
  }

  @RequirePermission('schedule.manage')
  @Delete('calendar/blocks/:id')
  deleteBlock(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.owner.deleteCalendarBlock(user, id);
  }

  @RequirePermission('reports.view')
  @Get('finance')
  finance(
    @CurrentUser() user: AuthenticatedUser,
    @Query('venueId') venueId: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    return this.owner.finance(user, venueId, from, to);
  }

  @RequirePermission('reports.view')
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

  @RequirePermission('reports.view')
  @Get('exports')
  @ApiOperation({ summary: 'Export centre: one workbook (xlsx) or zip of CSVs for any period' })
  async exportCentreDownload(
    @CurrentUser() user: AuthenticatedUser,
    @Query('venueId') venueId: string,
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('lang') lang?: string,
    @Query('format') format?: string,
  ) {
    const out = await this.exportCentre.build(user, { venueId, from, to, lang, format });
    return new StreamableFile(Buffer.from(out.file), {
      type: out.contentType,
      disposition: `attachment; filename="${out.filename}"`,
    });
  }

  @RequirePermission('customers.view')
  @Get('customers')
  customers(
    @CurrentUser() user: AuthenticatedUser,
    @Query('venueId') venueId: string,
  ) {
    return this.owner.customers(user, venueId);
  }

  @OwnerOnly()
  @Get('payout-methods')
  listPayouts(@CurrentUser() user: AuthenticatedUser) {
    return this.owner.listPayoutMethods(user.id);
  }

  @OwnerOnly()
  @Post('payout-methods')
  createPayout(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreatePayoutMethodDto,
  ) {
    return this.owner.createPayoutMethod(user.id, dto);
  }

  @OwnerOnly()
  @Delete('payout-methods/:id')
  deletePayout(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.owner.deletePayoutMethod(user.id, id);
  }

  @RequirePermission('bookings.view')
  @Post('fixed-bookings/preview')
  @ApiOperation({ summary: 'Preview a weekly fixed booking: dates, prices and clashes' })
  previewFixed(@CurrentUser() user: AuthenticatedUser, @Body() dto: FixedSeriesShapeDto) {
    return this.fixed.preview(user, dto);
  }

  @RequirePermission('bookings.create')
  @Post('fixed-bookings')
  @ApiOperation({ summary: 'Create a weekly fixed booking (books the next 8 weeks)' })
  createFixed(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateFixedSeriesDto) {
    return this.fixed.create(user, dto);
  }

  @RequirePermission('bookings.view')
  @Get('fixed-bookings')
  @ApiOperation({ summary: 'Active fixed bookings of a venue' })
  listFixed(@CurrentUser() user: AuthenticatedUser, @Query('venueId') venueId: string) {
    return this.fixed.list(user, venueId);
  }

  @RequirePermission('bookings.edit')
  @Post('fixed-bookings/:id/skip')
  @ApiOperation({ summary: 'Skip one date of a fixed booking' })
  skipFixed(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: SeriesDateDto) {
    return this.fixed.skipDate(user, id, dto.date);
  }

  @RequirePermission('bookings.edit')
  @Post('fixed-bookings/:id/cancel-from')
  @ApiOperation({ summary: 'End a fixed booking from a date onward' })
  cancelFixedFrom(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: SeriesDateDto) {
    return this.fixed.cancelFrom(user, id, dto.date);
  }

  @RequirePermission('bookings.edit')
  @Post('fixed-bookings/:id/reschedule')
  @ApiOperation({ summary: 'Change the hour of a fixed booking from a date onward' })
  rescheduleFixed(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: RescheduleSeriesDto) {
    return this.fixed.reschedule(user, id, dto);
  }

  @RequireAnyPermission('reports.view', 'payments.record')
  @Get('cash-today')
  @ApiOperation({ summary: 'Payments recorded on today\'s bookings by method (read-only drawer check)' })
  cashToday(@CurrentUser() user: AuthenticatedUser, @Query('venueId') venueId: string) {
    return this.summary.cashToday(user, venueId);
  }

  @RequirePermission('reports.view')
  @Get('expenses')
  @ApiOperation({ summary: 'Expenses of a venue (monthly ones are generated on read)' })
  listExpenses(
    @CurrentUser() user: AuthenticatedUser,
    @Query('venueId') venueId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('category') category?: string,
  ) {
    return this.expenses.list(user, { venueId, from, to, category });
  }

  @RequirePermission('expenses.manage')
  @Post('expenses')
  @ApiOperation({ summary: 'Record an expense' })
  createExpense(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateExpenseDto) {
    return this.expenses.create(user, dto);
  }

  @RequirePermission('expenses.manage')
  @Patch('expenses/:id')
  @ApiOperation({ summary: 'Edit an expense' })
  updateExpense(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: UpdateExpenseDto) {
    return this.expenses.update(user, id, dto);
  }

  @RequirePermission('expenses.manage')
  @Delete('expenses/:id')
  @ApiOperation({ summary: 'Delete an expense' })
  deleteExpense(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.expenses.remove(user, id);
  }

  @RequirePermission('bookings.create')
  @Post('bookings/manual')
  @ApiOperation({ summary: 'Create a manual (walk-in / phone / WhatsApp) booking' })
  createManual(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateManualBookingDto,
  ) {
    return this.ownerBookings.createManualBooking(user, dto);
  }

  @RequirePermission('bookings.view')
  @Get('bookings/:id')
  @ApiOperation({ summary: 'One booking by id' })
  getBooking(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.ownerBookings.getBooking(user, id);
  }

  @RequirePermission('bookings.edit')
  @Patch('bookings/:id')
  @ApiOperation({ summary: 'Update a manual booking (platform bookings are locked)' })
  updateManual(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateManualBookingDto,
  ) {
    return this.ownerBookings.updateManualBooking(user, id, dto);
  }

  @RequirePermission('bookings.edit')
  @Delete('bookings/:id')
  @ApiOperation({ summary: 'Soft-cancel a manual booking' })
  deleteManual(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.ownerBookings.deleteManualBooking(user, id);
  }

  @RequirePermission('bookings.edit')
  @Post('bookings/:id/restore')
  @ApiOperation({ summary: 'Restore a cancelled manual booking if the slot is free' })
  restoreManual(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.ownerBookings.restoreManualBooking(user, id);
  }

  @RequirePermission('payments.record')
  @Post('bookings/:id/payments')
  @ApiOperation({ summary: 'Record a later payment on a manual booking' })
  addPayment(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: AddManualPaymentDto,
  ) {
    return this.ownerBookings.addManualPayment(user, id, dto.amount, dto.method);
  }

  @RequirePermission('bookings.view')
  @Get('venues/:venueId/booking-sources')
  @ApiOperation({ summary: 'List preset and saved booking sources' })
  listSources(
    @CurrentUser() user: AuthenticatedUser,
    @Param('venueId') venueId: string,
  ) {
    return this.ownerBookings.listSources(user, venueId);
  }

  @RequirePermission('bookings.edit')
  @Delete('venues/:venueId/booking-sources/:id')
  @ApiOperation({ summary: 'Forget a saved custom source label' })
  deleteSource(
    @CurrentUser() user: AuthenticatedUser,
    @Param('venueId') venueId: string,
    @Param('id') id: string,
  ) {
    return this.ownerBookings.deleteSource(user, venueId, id);
  }

  @RequirePermission('reports.view')
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

  @RequirePermission('bookings.view')
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

  @RequirePermission('account.view')
  @Get('matchena-account')
  @ApiOperation({ summary: 'Owner Matchena ledger balance (read-only)' })
  matchenaAccount(
    @CurrentUser() user: AuthenticatedUser,
    @Query('venueId') venueId: string,
  ) {
    return this.ownerBookings.getMatchenaAccount(user, venueId);
  }

  @RequirePermission('account.remit')
  @Post('matchena-account/remittances')
  @ApiOperation({ summary: 'Submit a remittance for Matchena to confirm' })
  createRemittance(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: OwnerRemittanceDto,
  ) {
    return this.ownerBookings.createRemittance(user, dto);
  }

  @RequirePermission('account.remit')
  @Delete('matchena-account/remittances/:id')
  @ApiOperation({ summary: 'Cancel a pending remittance' })
  cancelRemittance(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.ownerBookings.cancelRemittance(user, id);
  }

  @RequirePermission('bookings.view')
  @Get('attention')
  @ApiOperation({ summary: 'Bookings needing arrival confirmation or unpaid manuals' })
  attention(
    @CurrentUser() user: AuthenticatedUser,
    @Query('venueId') venueId: string,
  ) {
    return this.ownerBookings.attention(user, venueId);
  }

  @RequirePermission('bookings.view')
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

  // ---- Occupancy map, idle windows and time-boxed discounts ----
  @RequirePermission('reports.view')
  @Get('insights/occupancy')
  occupancy(@CurrentUser() user: AuthenticatedUser, @Query() q: OccupancyQueryDto) {
    return this.insights.occupancy(user, q.venueId, q.weeks);
  }

  @RequirePermission('reports.view')
  @Get('insights/discounts')
  discounts(@CurrentUser() user: AuthenticatedUser, @Query('venueId') venueId: string) {
    return this.insights.listDiscounts(user, venueId);
  }

  @RequirePermission('pricing.manage')
  @Post('insights/discounts')
  applyDiscount(@CurrentUser() user: AuthenticatedUser, @Body() dto: ApplyDiscountDto) {
    return this.insights.applyDiscount(user, dto);
  }

  @RequirePermission('pricing.manage')
  @Delete('insights/discounts/:id')
  endDiscount(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.insights.endDiscount(user, id);
  }

  @RequirePermission('pricing.manage')
  @Post('insights/dismiss')
  dismissSuggestion(@CurrentUser() user: AuthenticatedUser, @Body() dto: WindowDto) {
    return this.insights.dismiss(user, dto);
  }

  @RequirePermission('bookings.checkin')
  @Post('bookings/verify-qr')
  verifyQr(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: VerifyVenueQrDto,
  ) {
    return this.bookings.verifyVenueQr(user, dto);
  }

  @RequirePermission('bookings.checkin')
  @Post('bookings/:id/no-show')
  markNoShow(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.bookings.markNoShow(user, id);
  }

  @RequireAnyPermission('venue.manage', 'team.manage')
  @Get('quickstart')
  @ApiOperation({ summary: 'New-owner checklist, derived from real data' })
  quickstartSteps(@CurrentUser() user: AuthenticatedUser, @Query('venueId') venueId: string) {
    return this.quickstart.forVenue(user, venueId);
  }

  @RequirePermission('bookings.view')
  @Get('platform-requests')
  @ApiOperation({ summary: "This venue's requests to Matchena about Matchena bookings, with the answers" })
  listPlatformRequests(@CurrentUser() user: AuthenticatedUser, @Query('venueId') venueId: string) {
    return this.platformRequests.listForVenue(user, venueId);
  }

  @RequirePermission('bookings.edit')
  @Post('bookings/:id/change-request')
  @ApiOperation({ summary: 'Ask the admin to cancel or change a Matchena booking' })
  requestChange(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: PlatformChangeRequestDto,
  ) {
    return this.ownerBookings.requestPlatformChange(user, id, dto);
  }

  @RequirePermission('bookings.edit')
  @Post('bookings/:id/cancel')
  ownerCancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: OwnerBookingActionDto,
  ) {
    return this.bookings.ownerCancel(user, id, dto.reason);
  }

  @RequirePermission('bookings.checkin')
  @Post('bookings/:id/checkin')
  ownerCheckIn(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.bookings.checkInById(user, id);
  }
}
