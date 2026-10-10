import { Body, Controller, Get, Post, Put, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../../../common/guards/auth.guard';
import { Roles } from '../../../common/decorators/roles.decorator';
import { RequirePermission } from '../../../common/decorators/permissions.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { AdminEditAuditInterceptor } from '../../../common/interceptors/admin-edit-audit.interceptor';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.interface';
import { GamingVenueQueryDto, PublishGamingLayoutDto, RestoreGamingLayoutDto, SaveGamingLayoutDto } from './gaming-layout.dto';
import { GamingLayoutService } from './gaming-layout.service';
@ApiTags('owner-gaming')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@UseInterceptors(AdminEditAuditInterceptor)
@Roles('owner', 'staff', 'admin')
@Controller('owner/layout')
export class GamingLayoutController {
  constructor(private readonly layouts: GamingLayoutService) {}
  @Get() @RequirePermission('layout.view')
  read(@CurrentUser() user: AuthenticatedUser, @Query() query: GamingVenueQueryDto) { return this.layouts.read(user, query.venueId); }
  @Put('draft') @RequirePermission('layout.edit')
  save(@CurrentUser() user: AuthenticatedUser, @Body() dto: SaveGamingLayoutDto) { return this.layouts.save(user, dto); }
  @Post('publish') @RequirePermission('layout.publish')
  publish(@CurrentUser() user: AuthenticatedUser, @Body() dto: PublishGamingLayoutDto) { return this.layouts.publish(user, dto); }
  @Get('revisions') @RequirePermission('layout.edit')
  history(@CurrentUser() user: AuthenticatedUser, @Query() q: GamingVenueQueryDto) { return this.layouts.history(user,q.venueId); }
  @Post('restore') @RequirePermission('layout.publish')
  restore(@CurrentUser() user: AuthenticatedUser, @Body() dto: RestoreGamingLayoutDto) { return this.layouts.restore(user,dto); }
}
