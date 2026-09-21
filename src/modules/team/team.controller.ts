import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../../common/guards/auth.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { RequirePermission } from '../../common/decorators/permissions.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.interface';
import { TeamService } from './team.service';
import { CreateTeamMemberDto, UpdateTeamMemberDto } from './dto/team.dto';

/**
 * The venue team: staff logins created by the owner, a delegated manager or the
 * platform admin. The admin is never read-only here — he can add, rename, change
 * and remove anyone (every action is audited with his id).
 */
@ApiTags('team')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Roles('owner', 'staff', 'admin')
@RequirePermission('team.manage')
@Controller('team')
export class TeamController {
  constructor(private readonly team: TeamService) {}

  @Get('catalog')
  catalog() {
    return this.team.catalog();
  }

  @Get()
  async list(@CurrentUser() user: AuthenticatedUser, @Query('venueId') venueId?: string) {
    return this.team.list(await this.team.resolveActor(user, venueId));
  }

  @Post()
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateTeamMemberDto,
    @Query('venueId') venueId?: string,
  ) {
    return this.team.create(await this.team.resolveActor(user, venueId), dto);
  }

  @Patch(':id')
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateTeamMemberDto,
    @Query('venueId') venueId?: string,
  ) {
    return this.team.update(await this.team.resolveActor(user, venueId), id, dto);
  }

  @Delete(':id')
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Query('venueId') venueId?: string,
  ) {
    return this.team.remove(await this.team.resolveActor(user, venueId), id);
  }
}
