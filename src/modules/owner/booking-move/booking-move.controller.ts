import {
  Body,
  Controller,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthGuard } from '../../../common/guards/auth.guard';
import { AdminEditAuditInterceptor } from '../../../common/interceptors/admin-edit-audit.interceptor';
import { Roles } from '../../../common/decorators/roles.decorator';
import { RequirePermission } from '../../../common/decorators/permissions.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.interface';
import { MoveBookingDto, MoveBookingPreviewDto } from './booking-move.dto';
import { BookingMoveService } from './booking-move.service';

@ApiTags('owner')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Roles('owner', 'staff', 'admin')
@UseInterceptors(AdminEditAuditInterceptor)
@Controller('owner/bookings')
export class BookingMoveController {
  constructor(private readonly moves: BookingMoveService) {}

  @RequirePermission('bookings.edit')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post(':id/move-preview')
  @ApiOperation({
    summary:
      'What moving this booking would do, and the free times and units it could move to. Changes nothing.',
  })
  preview(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: MoveBookingPreviewDto,
  ) {
    return this.moves.preview(user, id, dto);
  }

  @RequirePermission('bookings.edit')
  @Throttle({ default: { limit: 15, ttl: 60_000 } })
  @Post(':id/move')
  @ApiOperation({
    summary: 'Move a booking to another time and/or unit. Never moves money.',
  })
  move(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: MoveBookingDto,
  ) {
    return this.moves.move(user, id, dto);
  }
}
