import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthGuard } from '../../common/guards/auth.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { AnyStaff } from '../../common/decorators/permissions.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.interface';
import { CallsService } from './calls.service';
import { CreateCallDto, DoNotDisturbDto, MuteCallsDto } from './dto/calls.dto';

/**
 * Owner <-> team calls. Open to the venue owner and every staff account of that owner (no permission
 * key: the team can always reach each other); the service enforces "same organisation" on every call.
 * The platform admin may start calls to any owner or staff member (and look them up to do so).
 * Players and guests are refused by role.
 */
@ApiTags('calls')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Roles('owner', 'staff', 'admin')
@AnyStaff()
@Controller('calls')
export class CallsController {
  constructor(private readonly calls: CallsService) {}

  @Get('directory')
  directory(@CurrentUser() user: AuthenticatedUser) {
    return this.calls.directory(user.id);
  }

  @Get('admin/search')
  @Roles('admin')
  adminSearch(@CurrentUser() user: AuthenticatedUser, @Query('q') q?: string) {
    return this.calls.adminSearch(user.id, q ?? '');
  }

  @Get('admin/venues/:venueId')
  @Roles('admin')
  adminVenue(
    @CurrentUser() user: AuthenticatedUser,
    @Param('venueId') venueId: string,
  ) {
    return this.calls.adminVenue(user.id, venueId);
  }

  @Get('active')
  active(@CurrentUser() user: AuthenticatedUser) {
    return this.calls.active(user.id);
  }

  @Get('recent')
  recent(
    @CurrentUser() user: AuthenticatedUser,
    @Query('limit') limit?: string,
  ) {
    return this.calls.recent(user.id, Number(limit) || 30);
  }

  @Post('recent/seen')
  @HttpCode(HttpStatus.OK)
  seen(@CurrentUser() user: AuthenticatedUser) {
    return this.calls.markSeen(user.id);
  }

  @Get('ice-servers')
  iceServers(@CurrentUser() user: AuthenticatedUser) {
    return this.calls.iceServers(user.id);
  }

  @Put('dnd')
  dnd(@CurrentUser() user: AuthenticatedUser, @Body() dto: DoNotDisturbDto) {
    return this.calls.setDnd(user.id, dto.minutes);
  }

  @Put('mutes/:userId')
  mute(
    @CurrentUser() user: AuthenticatedUser,
    @Param('userId') userId: string,
    @Body() dto: MuteCallsDto,
  ) {
    return this.calls.setMute(user.id, userId, dto.minutes);
  }

  @Delete('mutes/:userId')
  unmute(
    @CurrentUser() user: AuthenticatedUser,
    @Param('userId') userId: string,
  ) {
    return this.calls.clearMute(user.id, userId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { limit: 12, ttl: 60_000 } })
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateCallDto) {
    return this.calls.create(user.id, dto.calleeId);
  }

  @Post(':id/accept')
  @HttpCode(HttpStatus.OK)
  accept(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.calls.accept(user.id, id);
  }

  @Post(':id/decline')
  @HttpCode(HttpStatus.OK)
  decline(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.calls.decline(user.id, id);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.calls.cancel(user.id, id);
  }

  @Post(':id/end')
  @HttpCode(HttpStatus.OK)
  end(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.calls.end(user.id, id);
  }
}
