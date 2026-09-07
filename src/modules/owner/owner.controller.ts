import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  Patch,
  Post,
  Query,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../../common/guards/auth.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.interface';
import { OwnerService } from './owner.service';
import { CreateStaffInviteDto } from './dto/staff-invite.dto';
import { CreateWalkInDto } from './dto/walk-in.dto';
import {
  CreateCalendarBlockDto,
  CreatePayoutMethodDto,
  OwnerBookingActionDto,
  VerifyVenueQrDto,
} from './dto/owner-operations.dto';
import { SetStaffStatusDto } from './dto/status-actions.dto';
import { BookingsService } from '../bookings/bookings.service';

@ApiTags('owner')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Roles('owner', 'staff', 'admin')
@Controller('owner')
export class OwnerController {
  constructor(
    private readonly owner: OwnerService,
    private readonly bookings: BookingsService,
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
    return this.owner.calendar(user.id, venueId, date);
  }

  @Post('calendar/walk-in')
  walkIn(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateWalkInDto,
  ) {
    return this.owner.createWalkInBooking(user.id, dto);
  }

  @Post('calendar/blocks')
  createBlock(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateCalendarBlockDto,
  ) {
    return this.owner.createCalendarBlock(user.id, dto);
  }

  @Delete('calendar/blocks/:id')
  deleteBlock(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.owner.deleteCalendarBlock(user.id, id);
  }

  @Get('finance')
  finance(
    @CurrentUser() user: AuthenticatedUser,
    @Query('venueId') venueId: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    return this.owner.finance(user.id, venueId, from, to);
  }

  @Get('finance/export')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  async financeExport(
    @CurrentUser() user: AuthenticatedUser,
    @Query('venueId') venueId: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    const csv = await this.owner.financeCsv(user.id, venueId, from, to);
    return new StreamableFile(Buffer.from(csv, 'utf8'), {
      type: 'text/csv; charset=utf-8',
      disposition: `attachment; filename="mal3ab-finance-${venueId}.csv"`,
    });
  }

  @Get('customers')
  customers(
    @CurrentUser() user: AuthenticatedUser,
    @Query('venueId') venueId: string,
  ) {
    return this.owner.customers(user.id, venueId);
  }

  @Post('staff-invites')
  inviteStaff(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateStaffInviteDto,
  ) {
    return this.owner.inviteStaff(user.id, dto);
  }

  @Get('staff-invites')
  listStaffInvites(
    @CurrentUser() user: AuthenticatedUser,
    @Query('venueId') venueId: string,
  ) {
    return this.owner.listStaffInvites(user.id, venueId);
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
    return this.owner.revokeStaffInvite(user.id, id);
  }

  @Patch('staff-invites/:id')
  setStaffStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: SetStaffStatusDto,
  ) {
    return this.owner.setStaffStatus(user.id, id, dto.status);
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
