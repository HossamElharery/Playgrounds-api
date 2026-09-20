import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthGuard } from '../../common/guards/auth.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.interface';
import { IdempotencyInterceptor } from '../../common/interceptors/idempotency.interceptor';
import { AdminFinanceService } from './admin-finance.service';
import {
  AdminAdjustmentDto,
  AdminBalancesQueryDto,
  AdminCommissionDto,
  AdminConfirmSettlementDto,
  AdminGlobalCommissionDto,
  AdminPaymentModeDto,
  AdminPayoutDto,
  AdminRejectSettlementDto,
  AdminVerifyLedgerDto,
} from './dto/admin-finance.dto';

@ApiTags('admin-finance')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Roles('admin')
@Controller('admin')
export class AdminFinanceController {
  constructor(private readonly finance: AdminFinanceService) {}

  @Get('venues/:id/finance-settings')
  @ApiOperation({ summary: 'Venue commission and payment-mode settings' })
  financeSettings(@Param('id') id: string) {
    return this.finance.financeSettings(id);
  }

  @Patch('venues/:id/commission')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'Set or clear venue commission override' })
  patchCommission(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: AdminCommissionDto,
  ) {
    return this.finance.patchCommission(user, id, dto);
  }

  @Patch('venues/:id/payment-mode')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'Switch venue payment mode' })
  patchPaymentMode(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: AdminPaymentModeDto,
  ) {
    return this.finance.patchPaymentMode(user, id, dto);
  }

  @Get('finance/global-commission')
  globalCommission() {
    return this.finance.getGlobalCommission();
  }

  @Patch('finance/global-commission')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  patchGlobalCommission(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: AdminGlobalCommissionDto,
  ) {
    return this.finance.patchGlobalCommission(user, dto);
  }

  @Get('finance/balances')
  balances(@Query() query: AdminBalancesQueryDto) {
    return this.finance.balances(query);
  }

  @Get('venues/:id/audit')
  @ApiOperation({ summary: 'Cursor-paginated audit trail for one venue' })
  venueAudit(
    @Param('id') id: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.finance.venueAudit(id, cursor, limit ? Number(limit) : undefined);
  }

  @Get('venues/:id/ledger')
  ledger(
    @Param('id') id: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.finance.venueLedger(id, cursor, limit ? Number(limit) : 30);
  }

  @Post('venues/:id/settlements/payout')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @UseInterceptors(IdempotencyInterceptor)
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiOperation({ summary: 'Record a Matchena payout to the owner' })
  payout(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: AdminPayoutDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.finance.payout(user, id, dto, idempotencyKey);
  }

  @Post('venues/:id/settlements/remittance')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'Record an owner remittance that is already confirmed' })
  remittance(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: AdminPayoutDto,
  ) {
    return this.finance.recordRemittance(user, id, dto);
  }

  @Get('finance/remittances')
  remittances(@Query('status') status?: string) {
    return this.finance.listRemittances(status);
  }

  @Post('settlements/:id/confirm')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  confirm(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: AdminConfirmSettlementDto,
  ) {
    return this.finance.confirmSettlement(user, id, dto.reason);
  }

  @Post('settlements/:id/reject')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  reject(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: AdminRejectSettlementDto,
  ) {
    return this.finance.rejectSettlement(user, id, dto.reason);
  }

  @Post('venues/:id/ledger/adjustment')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  adjustment(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: AdminAdjustmentDto,
  ) {
    return this.finance.adjustment(user, id, dto);
  }

  @Post('venues/:id/ledger/verify')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  verify(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: AdminVerifyLedgerDto,
  ) {
    return this.finance.verify(user, id, !!dto.repair, dto.reason);
  }

  @Get('venues/:id/overview')
  overview(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.finance.venueOverview(user, id);
  }

  @Get('venues/:id/summary')
  summary(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Query('range') range?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.finance.venueSummary(user, id, range, from, to);
  }

  @Get('venues/:id/bookings')
  bookings(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
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
    return this.finance.venueBookings(user, id, {
      venueId: id,
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

  @Get('venues/:id/customers')
  customers(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.finance.venueCustomers(user, id);
  }

  @Get('venues/:id/board')
  board(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Query('date') date: string,
  ) {
    return this.finance.venueBoard(user, id, date);
  }

  @Get('venues/:id/calendar')
  calendar(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Query('date') date: string,
  ) {
    return this.finance.venueCalendar(user, id, date);
  }

  @Get('finance/availability')
  availability(@Query('venueId') venueId: string) {
    return this.finance.availability(venueId);
  }

  @Get('venues/:id/view-as-owner/context')
  viewAsOwner(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.finance.viewAsOwnerContext(user, id);
  }
}
