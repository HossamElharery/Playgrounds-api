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
import { TournamentsService } from './tournaments.service';
import {
  CreateTournamentDto,
  ListTournamentsQueryDto,
  ReportMatchResultDto,
} from './dto/tournament.dto';

@ApiTags('tournaments')
@Controller('tournaments')
export class TournamentsController {
  constructor(private readonly tournaments: TournamentsService) {}

  @Public()
  @Get()
  list(@Query() query: ListTournamentsQueryDto) {
    return this.tournaments.list(query);
  }

  @Public()
  @Get(':id')
  get(@Param('id') id: string) {
    return this.tournaments.get(id);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('owner', 'admin')
  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateTournamentDto,
  ) {
    return this.tournaments.create(user, dto);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('player', 'owner', 'admin')
  @Post(':id/register')
  register(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.tournaments.register(user.id, id);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('owner', 'admin')
  @Post(':id/bracket/generate')
  generateBracket(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.tournaments.generateBracket(user, id);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('player', 'owner', 'admin')
  @Post(':id/matches/:matchId/result')
  reportResult(
    @Param('id') id: string,
    @Param('matchId') matchId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ReportMatchResultDto,
  ) {
    return this.tournaments.reportResult(user, id, matchId, dto);
  }
}
