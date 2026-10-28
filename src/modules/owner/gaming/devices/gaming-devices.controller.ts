import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../../../../common/guards/auth.guard';
import { Roles } from '../../../../common/decorators/roles.decorator';
import { RequirePermission } from '../../../../common/decorators/permissions.decorator';
import { CurrentUser } from '../../../../common/decorators/current-user.decorator';
import { AdminEditAuditInterceptor } from '../../../../common/interceptors/admin-edit-audit.interceptor';
import { AuthenticatedUser } from '../../../../common/types/authenticated-user.interface';
import { GamingCommandDto, GamingQueryDto } from '../gaming-operations.dto';
import { GamingDevicesService } from './gaming-devices.service';
import {
  DeviceOverrideDto,
  DeviceTestDto,
  UpdateGamingDeviceDto,
} from './gaming-devices.dto';

@ApiTags('owner-gaming')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@UseInterceptors(AdminEditAuditInterceptor)
@Roles('owner', 'staff', 'admin')
@Controller('owner/gaming/devices')
export class GamingDevicesController {
  constructor(private readonly devices: GamingDevicesService) {}
  @Get() @RequirePermission('devices.manage') list(
    @CurrentUser() u: AuthenticatedUser,
    @Query() q: GamingQueryDto,
  ) {
    return this.devices.overview(u, q.venueId);
  }
  @Post('link/rotate') @RequirePermission('devices.manage') rotate(
    @CurrentUser() u: AuthenticatedUser,
    @Body() d: GamingCommandDto,
  ) {
    return this.devices.rotateLink(u, d);
  }
  @Put(':id') @RequirePermission('devices.manage') update(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() d: UpdateGamingDeviceDto,
  ) {
    return this.devices.update(u, id, d);
  }
  @Delete(':id') @RequirePermission('devices.manage') remove(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() d: GamingCommandDto,
  ) {
    return this.devices.remove(u, id, d);
  }
  @Post(':id/test') @RequirePermission('devices.manage') test(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() d: DeviceTestDto,
  ) {
    return this.devices.test(u, id, d);
  }
  @Post(':id/override') @RequirePermission('devices.manage') override(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() d: DeviceOverrideDto,
  ) {
    return this.devices.override(u, id, d);
  }
  @Get(':id/logs') @RequirePermission('devices.manage') logs(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: GamingQueryDto,
  ) {
    return this.devices.logs(u, q.venueId, id);
  }
}
