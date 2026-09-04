import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { AuthGuard } from '../../common/guards/auth.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RbacService } from './rbac.service';
import { CreateRoleDto } from './dto/create-role.dto';
import { AssignRoleDto } from './dto/assign-role.dto';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.interface';

@ApiTags('rbac')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Roles('owner')
@Controller('rbac')
export class RbacController {
  constructor(private readonly rbac: RbacService) {}

  @Get('permissions')
  listPermissions() {
    return this.rbac.listPermissions();
  }

  @Get('roles')
  listRoles(@CurrentUser() user: AuthenticatedUser) {
    return this.rbac.listRoles(user.id);
  }

  @Post('roles')
  createRole(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateRoleDto) {
    return this.rbac.createRole(user.id, dto);
  }

  @Post('assignments')
  assign(@CurrentUser() user: AuthenticatedUser, @Body() dto: AssignRoleDto) {
    return this.rbac.assignRole(user.id, dto);
  }

  @Delete('assignments/:id')
  revoke(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.rbac.revokeAssignment(user.id, id);
  }
}
