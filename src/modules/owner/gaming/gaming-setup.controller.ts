import { Body, Controller, Get, Post, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../../../common/guards/auth.guard';
import { Roles } from '../../../common/decorators/roles.decorator';
import { RequirePermission } from '../../../common/decorators/permissions.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { AdminEditAuditInterceptor } from '../../../common/interceptors/admin-edit-audit.interceptor';
import { AuthenticatedUser } from '../../../common/types/authenticated-user.interface';
import { GamingQueryDto } from './gaming-operations.dto';
import { GamingSetupDto } from './gaming-setup.dto';
import { GamingSetupService } from './gaming-setup.service';
@ApiTags('owner-gaming') @ApiBearerAuth() @UseGuards(AuthGuard) @UseInterceptors(AdminEditAuditInterceptor) @Roles('owner','staff','admin')
@Controller('owner/gaming/setup')
export class GamingSetupController {
 constructor(private readonly setupService:GamingSetupService){}
 @Get() @RequirePermission('venue.manage','pricing.manage','layout.edit','layout.publish') status(@CurrentUser() u:AuthenticatedUser,@Query() q:GamingQueryDto){return this.setupService.status(u,q.venueId);}
 @Post() @RequirePermission('venue.manage','pricing.manage','layout.edit','layout.publish') setup(@CurrentUser() u:AuthenticatedUser,@Body() d:GamingSetupDto){return this.setupService.setup(u,d);}
}
