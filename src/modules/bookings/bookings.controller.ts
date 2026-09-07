import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../../common/guards/auth.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.interface';
import { BookingsService } from './bookings.service';
import { HoldSlotDto } from './dto/hold-slot.dto';
import { ConfirmBookingDto } from './dto/confirm-booking.dto';
import { CancelBookingDto } from './dto/cancel-booking.dto';
import { SlotGridQueryDto } from './dto/slot-grid-query.dto';
import { CreateRecurringSeriesDto } from './dto/recurring-booking.dto';
import { ValidatePromoDto } from './dto/validate-promo.dto';
import { CheckinBookingDto } from './dto/checkin-booking.dto';
import {
  ListMyBookingsQueryDto,
  ListVenueBookingsQueryDto,
} from './dto/list-bookings-query.dto';
import { PageQueryDto } from '../../common/dto/page-query.dto';

@ApiTags('bookings')
@Controller()
export class BookingsController {
  constructor(private readonly bookings: BookingsService) {}

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Post('promo-codes/validate')
  validatePromo(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ValidatePromoDto,
  ) {
    return this.bookings.previewPromo(dto.code, user.id, dto.amount ?? 0);
  }

  @Public()
  @Get('courts/:courtId/slots')
  slotGrid(@Param('courtId') courtId: string, @Query() q: SlotGridQueryDto) {
    return this.bookings.getSlotGrid(courtId, q.date);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Post('bookings/hold')
  hold(@CurrentUser() user: AuthenticatedUser, @Body() dto: HoldSlotDto) {
    return this.bookings.holdSlot(user.id, dto);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Post('bookings/:id/confirm')
  confirm(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ConfirmBookingDto,
  ) {
    return this.bookings.confirmBooking(user.id, id, dto);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Post('bookings/:id/cancel')
  cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: CancelBookingDto,
  ) {
    return this.bookings.cancel(user.id, id, dto.reason);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('admin')
  @Get('admin/bookings')
  async listAdmin(@Query() q: PageQueryDto) {
    const { items, pagination } = await this.bookings.listAdmin(q.page, q.perPage);
    return { message: 'ok', result: items, pagination };
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Get('bookings/mine')
  listMine(
    @CurrentUser() user: AuthenticatedUser,
    @Query() q: ListMyBookingsQueryDto,
  ) {
    return this.bookings.listMine(user.id, q.scope ?? 'all');
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Get('bookings/:id')
  getById(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.bookings.getById(id, user);
  }

  @Public()
  @Post('bookings/split-shares/:token/pay')
  paySplitShare(@Param('token') token: string) {
    return this.bookings.paySplitShare(token);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('owner', 'staff', 'admin')
  @Post('bookings/checkin')
  checkIn(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CheckinBookingDto,
  ) {
    return this.bookings.checkIn(user, dto.qrPayload);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('owner', 'staff', 'admin')
  @Get('owner/venues/:venueId/bookings')
  listForVenue(
    @CurrentUser() user: AuthenticatedUser,
    @Param('venueId') venueId: string,
    @Query() q: ListVenueBookingsQueryDto,
  ) {
    return this.bookings.listForVenue(venueId, user, q.status, q.q);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Post('bookings/recurring')
  createSeries(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateRecurringSeriesDto,
  ) {
    return this.bookings.createRecurringSeries(user.id, dto);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Get('bookings/recurring/mine')
  listMySeries(@CurrentUser() user: AuthenticatedUser) {
    return this.bookings.listMySeries(user.id);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Post('bookings/recurring/:seriesId/confirm-next')
  confirmNext(
    @CurrentUser() user: AuthenticatedUser,
    @Param('seriesId') seriesId: string,
    @Body() dto: ConfirmBookingDto,
  ) {
    return this.bookings.confirmNextOccurrence(
      user.id,
      seriesId,
      dto.paymentMethod,
    );
  }
}
