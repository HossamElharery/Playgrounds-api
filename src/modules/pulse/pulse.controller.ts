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
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../../common/guards/auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.interface';
import { IdempotencyInterceptor } from '../../common/interceptors/idempotency.interceptor';
import { PulseService } from './pulse.service';
import { SetAvailabilityDto } from './dto/set-availability.dto';
import { PulseFeedQueryDto } from './dto/feed-query.dto';

@ApiTags('pulse')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('pulse')
export class PulseController {
  constructor(private readonly pulse: PulseService) {}

  @Get()
  feed(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: PulseFeedQueryDto,
  ) {
    return this.pulse.feed(user.id, query);
  }

  @Get('availability/me')
  myAvailability(@CurrentUser() user: AuthenticatedUser) {
    return this.pulse.myAvailability(user.id);
  }

  @Put('availability/me')
  setAvailability(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: SetAvailabilityDto,
  ) {
    return this.pulse.setAvailability(user.id, dto);
  }

  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete('availability/me')
  clearAvailability(@CurrentUser() user: AuthenticatedUser) {
    return this.pulse.clearAvailability(user.id);
  }

  @Get('opportunities/:id')
  getOpportunity(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.pulse.getOpportunity(user.id, id);
  }

  @UseInterceptors(IdempotencyInterceptor)
  @Post('opportunities/:id/claims')
  claim(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.pulse.claim(user.id, id);
  }

  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete('opportunities/:id/claims/me')
  releaseClaim(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.pulse.releaseClaim(user.id, id);
  }

  @UseInterceptors(IdempotencyInterceptor)
  @Post('lobbies/:id/join')
  joinLobby(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.pulse.claim(user.id, id);
  }

  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete('lobbies/:id/members/me')
  leaveLobby(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.pulse.releaseClaim(user.id, id);
  }
}
