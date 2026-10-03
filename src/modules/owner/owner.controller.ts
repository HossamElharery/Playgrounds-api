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
  Put,
  Query,
  StreamableFile,
  UseGuards,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthGuard } from '../../common/guards/auth.guard';
import { AdminEditAuditInterceptor } from '../../common/interceptors/admin-edit-audit.interceptor';
import { Roles } from '../../common/decorators/roles.decorator';
import {
  AnyStaff,
  OwnerOnly,
  RequireAnyPermission,
  RequirePermission,
} from '../../common/decorators/permissions.decorator';
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
import { CashService } from './cash/cash.service';
import { ImportService } from './import/import.service';
import { ImportBodyDto } from './import/import.dto';
import { CustomerNoteDto } from './customers/customers.dto';
import { MAX_IMPORT_BYTES } from './import/spreadsheet.util';
import { CashDrawerQueryDto, CloseShiftDto, OpenShiftDto, ReviewShiftDto, ShiftListQueryDto } from './cash/cash.dto';
import { CreateExpenseDto, UpdateExpenseDto } from './expenses/expenses.dto';
import { InsightsService } from './insights/insights.service';
import {
  ApplyDiscountDto,
  OccupancyQueryDto,
  WindowDto,
} from './insights/dto/insights.dto';
import {
  AddManualPaymentDto,
  CreateManualBookingDto,
  OwnerCheckInDto,
  OwnerRemittanceDto,
  OwnerSummaryQueryDto,
  UpdateManualBookingDto,
  VoidPaymentDto,
} from './dto/manual-booking.dto';
import { ApiException } from '../../common/errors/api-exception';
import { OwnerAssistantService } from './assistant/owner-assistant.service';
import { CommandCentreService } from './command/command-centre.service';
import { ActivityService } from './activity/activity.service';
import { OwnerAssistantExecutorService } from './assistant/owner-assistant-executor.service';
import {
  AssistantAskDto,
  AssistantExecuteDto,
  UndoAssistantActionsDto,
} from './assistant/owner-assistant.dto';
import type { AssistantAction } from './assistant/assistant.types';

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
    private readonly cash: CashService,
    private readonly commandCentre: CommandCentreService,
    private readonly activity: ActivityService,
    private readonly imports: ImportService,
    private readonly exportCentre: ExportService,
    private readonly platformRequests: PlatformRequestsService,
    private readonly quickstart: QuickstartService,
    private readonly assistant: OwnerAssistantService,
    private readonly assistantExecutor: OwnerAssistantExecutorService,
  ) {}

  @AnyStaff()
  @Get('access')
  access(@CurrentUser() user: AuthenticatedUser) {
    return this.owner.access(user);
  }

  /** One screen for every venue the caller may see: today, what is owed, open drawers, what needs review. */
  @AnyStaff()
  @Get('command-centre')
  centre(@CurrentUser() user: AuthenticatedUser) {
    return this.commandCentre.centre(user);
  }

  /** Who booked, changed a price, took or returned money, took a drawer over — in plain sentences. */
  @RequirePermission('reports.view')
  @Get('activity')
  activityLog(
    @CurrentUser() user: AuthenticatedUser,
    @Query('venueId') venueId: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.activity.list(user, venueId, cursor);
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
  // Superseded by `assistant/ask`. Kept for app builds already in the stores,
  // which still speak this endpoint; new clients must not use it.
  @ApiOperation({
    summary: 'Deprecated: use POST /owner/assistant/ask',
    deprecated: true,
  })
  @Throttle({ default: { limit: 15, ttl: 60_000 } })
  @RequirePermission('schedule.manage')
  @Post('assistant/interpret')
  interpretAssistant(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: InterpretScheduleCommandDto,
  ) {
    return this.owner.interpretScheduleCommand(user, dto.venueId, dto.text);
  }

  /**
   * The owner assistant's planning call: one sentence in, a validated plan
   * out. Read-only — nothing is written until the owner confirms and the
   * client posts the plan back to `assistant/execute`. Throttled the same way
   * as `interpret`: every call costs a real model request.
   */
  @Throttle({ default: { limit: 15, ttl: 60_000 } })
  @RequirePermission('bookings.view')
  @Post('assistant/ask')
  askAssistant(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: AssistantAskDto,
  ) {
    return this.assistant.ask(user, dto.venueId, dto.text, {
      history: dto.history,
      draft: dto.draft,
    });
  }

  /** What deserves the owner's attention right now — powers the dashboard's proactive message. */
  @RequirePermission('bookings.view')
  @Get('assistant/attention')
  assistantAttention(
    @CurrentUser() user: AuthenticatedUser,
    @Query('venueId') venueId: string,
  ) {
    return this.assistant.attentionDigest(user, venueId);
  }

  /**
   * Runs a plan the owner confirmed. Each action is re-checked against the
   * caller's own permissions and then executed through the same services the
   * dashboard's buttons use.
   */
  @RequireAnyPermission(
    'bookings.create',
    'payments.record',
    'bookings.edit',
    'expenses.manage',
  )
  @Post('assistant/execute')
  executeAssistant(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: AssistantExecuteDto,
  ) {
    return this.assistantExecutor.execute(
      user,
      dto.venueId,
      dto.actions as unknown as AssistantAction[],
    );
  }

  /**
   * Takes back what one confirmed plan wrote (a booking, a payment, an expense,
   * a cancellation, an edit). The inverse is held server-side and is single-use
   * and short-lived; the permission to reverse each step is re-checked.
   */
  @RequireAnyPermission(
    'bookings.create',
    'payments.record',
    'bookings.edit',
    'expenses.manage',
  )
  @Post('assistant/undo-actions')
  undoAssistantActions(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UndoAssistantActionsDto,
  ) {
    return this.assistantExecutor.undo(user, dto.venueId, dto.undoId);
  }

  // The assistant is no longer schedule-only: its chat log is the record of
  // everything the owner asked it, so it follows the dashboard's baseline read
  // permission rather than the closure permission.
  @RequirePermission('bookings.view')
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

  @RequirePermission('bookings.view')
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
  @ApiOperation({
    summary: 'Deprecated: use POST /owner/bookings/manual',
    deprecated: true,
  })
  walkIn(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateWalkInDto) {
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
  deleteBlock(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
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
  @ApiOperation({
    summary: 'Export centre: one workbook (xlsx) or zip of CSVs for any period',
  })
  async exportCentreDownload(
    @CurrentUser() user: AuthenticatedUser,
    @Query('venueId') venueId: string,
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('lang') lang?: string,
    @Query('format') format?: string,
  ) {
    const out = await this.exportCentre.build(user, {
      venueId,
      from,
      to,
      lang,
      format,
    });
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
  @ApiOperation({
    summary: 'Preview a weekly fixed booking: dates, prices and clashes',
  })
  previewFixed(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: FixedSeriesShapeDto,
  ) {
    return this.fixed.preview(user, dto);
  }

  @RequirePermission('bookings.create')
  @Post('fixed-bookings')
  @ApiOperation({
    summary: 'Create a weekly fixed booking (books the next 8 weeks)',
  })
  createFixed(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateFixedSeriesDto,
  ) {
    return this.fixed.create(user, dto);
  }

  @RequirePermission('bookings.view')
  @Get('fixed-bookings')
  @ApiOperation({ summary: 'Active fixed bookings of a venue' })
  listFixed(
    @CurrentUser() user: AuthenticatedUser,
    @Query('venueId') venueId: string,
  ) {
    return this.fixed.list(user, venueId);
  }

  @RequirePermission('bookings.edit')
  @Post('fixed-bookings/:id/skip')
  @ApiOperation({ summary: 'Skip one date of a fixed booking' })
  skipFixed(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: SeriesDateDto,
  ) {
    return this.fixed.skipDate(user, id, dto.date);
  }

  @RequirePermission('bookings.edit')
  @Post('fixed-bookings/:id/cancel-from')
  @ApiOperation({ summary: 'End a fixed booking from a date onward' })
  cancelFixedFrom(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: SeriesDateDto,
  ) {
    return this.fixed.cancelFrom(user, id, dto.date);
  }

  @RequirePermission('bookings.edit')
  @Post('fixed-bookings/:id/reschedule')
  @ApiOperation({
    summary: 'Change the hour of a fixed booking from a date onward',
  })
  rescheduleFixed(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: RescheduleSeriesDto,
  ) {
    return this.fixed.reschedule(user, id, dto);
  }

  @RequireAnyPermission('reports.view', 'payments.record')
  @Get('cash-today')
  @ApiOperation({
    summary:
      "Payments recorded on today's bookings by method (read-only drawer check)",
  })
  cashToday(
    @CurrentUser() user: AuthenticatedUser,
    @Query('venueId') venueId: string,
  ) {
    return this.summary.cashToday(user, venueId);
  }

  @RequirePermission('customers.view')
  @Put('customers/note')
  @ApiOperation({ summary: 'Save (or clear) the venue\'s note about one customer' })
  customerNote(@CurrentUser() user: AuthenticatedUser, @Body() dto: CustomerNoteDto) {
    return this.owner.setCustomerNote(user, dto.venueId, dto.key, dto.note ?? null);
  }

  @RequirePermission('payments.record')
  @Get('cash/drawer')
  @ApiOperation({
    summary:
      'My open cash drawer (and, for reviewers, everybody\'s) — what is waiting to be closed',
  })
  cashDrawer(
    @CurrentUser() user: AuthenticatedUser,
    @Query() q: CashDrawerQueryDto,
  ) {
    return this.cash.drawer(user, q.venueId);
  }

  @RequirePermission('payments.record')
  @Post('cash/handovers')
  @ApiOperation({
    summary:
      'Take a cash drawer over at the start of a shift: count it, compare with what the last close left, write the difference down',
  })
  openShift(@CurrentUser() user: AuthenticatedUser, @Body() dto: OpenShiftDto) {
    return this.cash.openShift(user, dto);
  }

  @RequirePermission('payments.record')
  @Post('cash/shifts')
  @ApiOperation({
    summary:
      'Close a cash drawer: expected vs counted, difference, and what is left for the next shift',
  })
  closeShift(@CurrentUser() user: AuthenticatedUser, @Body() dto: CloseShiftDto) {
    return this.cash.closeShift(user, dto);
  }

  @RequirePermission('payments.record')
  @Get('cash/shifts')
  @ApiOperation({ summary: 'Closed shifts (all of them for reviewers, otherwise mine)' })
  listShifts(
    @CurrentUser() user: AuthenticatedUser,
    @Query() q: ShiftListQueryDto,
  ) {
    return this.cash.list(user, q);
  }

  @RequirePermission('payments.record')
  @Get('cash/shifts/:id')
  @ApiOperation({ summary: 'One closed shift with every payment and expense behind it' })
  shiftDetail(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.cash.detail(user, id);
  }

  @RequirePermission('shifts.review')
  @Post('cash/shifts/:id/review')
  @ApiOperation({ summary: 'Mark a shift as reviewed (with an optional note)' })
  reviewShift(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ReviewShiftDto,
  ) {
    return this.cash.review(user, id, dto?.note);
  }

  @RequirePermission('venue.manage')
  @Post('import/preview')
  @UseInterceptors(
    FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: MAX_IMPORT_BYTES, files: 1 } }),
  )
  @ApiOperation({ summary: 'Read an Excel/CSV file and show what an import would do — writes nothing' })
  importPreview(
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFile() file: { buffer: Buffer; originalname?: string } | undefined,
    @Body() body: ImportBodyDto,
  ) {
    return this.imports.preview(user, file, body.config);
  }

  @RequirePermission('venue.manage')
  @Post('import/commit')
  @UseInterceptors(
    FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: MAX_IMPORT_BYTES, files: 1 } }),
  )
  @ApiOperation({ summary: 'Import the rows of an Excel/CSV file that are fine (as one undoable batch)' })
  importCommit(
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFile() file: { buffer: Buffer; originalname?: string } | undefined,
    @Body() body: ImportBodyDto,
  ) {
    return this.imports.commit(user, file, body.config);
  }

  @RequirePermission('venue.manage')
  @Get('import/batches')
  @ApiOperation({ summary: 'Recent imports of a venue' })
  importBatches(@CurrentUser() user: AuthenticatedUser, @Query('venueId') venueId: string) {
    return this.imports.listBatches(user, venueId);
  }

  @RequirePermission('venue.manage')
  @Post('import/batches/:id/undo')
  @ApiOperation({ summary: 'Take a whole import back' })
  importUndo(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.imports.undo(user, id);
  }

  @RequirePermission('reports.view')
  @Get('expenses')
  @ApiOperation({
    summary: 'Expenses of a venue (monthly ones are generated on read)',
  })
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
  createExpense(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateExpenseDto,
  ) {
    return this.expenses.create(user, dto);
  }

  @RequirePermission('expenses.manage')
  @Patch('expenses/:id')
  @ApiOperation({ summary: 'Edit an expense' })
  updateExpense(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateExpenseDto,
  ) {
    return this.expenses.update(user, id, dto);
  }

  @RequirePermission('expenses.manage')
  @Delete('expenses/:id')
  @ApiOperation({ summary: 'Delete an expense' })
  deleteExpense(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.expenses.remove(user, id);
  }

  @RequirePermission('bookings.create')
  @Post('bookings/manual')
  @ApiOperation({
    summary: 'Create a manual (walk-in / phone / WhatsApp) booking',
  })
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
  @ApiOperation({
    summary: 'Update a manual booking (platform bookings are locked)',
  })
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
  @ApiOperation({
    summary: 'Restore a cancelled manual booking if the slot is free',
  })
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
    return this.ownerBookings.addManualPayment(
      user,
      id,
      dto.amount,
      dto.method,
    );
  }

  @RequirePermission('payments.record')
  @Post('bookings/:id/payments/:paymentId/void')
  @ApiOperation({
    summary:
      'Take a payment back (refund). Nothing is deleted: a negative row answers the original.',
  })
  voidPayment(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Param('paymentId') paymentId: string,
    @Body() dto: VoidPaymentDto,
  ) {
    return this.ownerBookings.voidManualPayment(user, id, paymentId, dto?.reason);
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
    return this.summary.getSummary(
      user,
      query.venueId,
      query.range ?? 'today',
      query.from,
      query.to,
    );
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
    @Query('scope') scope?: string,
  ) {
    return this.ownerBookings.listReportBookings(user, {
      scope,
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
  @ApiOperation({
    summary: 'Bookings needing arrival confirmation or unpaid manuals',
  })
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
  occupancy(
    @CurrentUser() user: AuthenticatedUser,
    @Query() q: OccupancyQueryDto,
  ) {
    return this.insights.occupancy(user, q.venueId, q.weeks);
  }

  @RequirePermission('reports.view')
  @Get('insights/discounts')
  discounts(
    @CurrentUser() user: AuthenticatedUser,
    @Query('venueId') venueId: string,
  ) {
    return this.insights.listDiscounts(user, venueId);
  }

  @RequirePermission('pricing.manage')
  @Post('insights/discounts')
  applyDiscount(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ApplyDiscountDto,
  ) {
    return this.insights.applyDiscount(user, dto);
  }

  @RequirePermission('pricing.manage')
  @Delete('insights/discounts/:id')
  endDiscount(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.insights.endDiscount(user, id);
  }

  @RequirePermission('pricing.manage')
  @Post('insights/dismiss')
  dismissSuggestion(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: WindowDto,
  ) {
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
  markNoShow(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.bookings.markNoShow(user, id);
  }

  @RequireAnyPermission('venue.manage', 'team.manage')
  @Get('quickstart')
  @ApiOperation({ summary: 'New-owner checklist, derived from real data' })
  quickstartSteps(
    @CurrentUser() user: AuthenticatedUser,
    @Query('venueId') venueId: string,
  ) {
    return this.quickstart.forVenue(user, venueId);
  }

  @RequirePermission('bookings.view')
  @Get('platform-requests')
  @ApiOperation({
    summary:
      "This venue's requests to Matchena about Matchena bookings, with the answers",
  })
  listPlatformRequests(
    @CurrentUser() user: AuthenticatedUser,
    @Query('venueId') venueId: string,
  ) {
    return this.platformRequests.listForVenue(user, venueId);
  }

  @RequirePermission('bookings.edit')
  @Post('bookings/:id/change-request')
  @ApiOperation({
    summary: 'Ask the admin to cancel or change a Matchena booking',
  })
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
    @Body() dto: OwnerCheckInDto,
  ) {
    return this.bookings.checkInById(user, id, dto?.method);
  }
}
