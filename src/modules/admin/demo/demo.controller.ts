import { Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../../../common/guards/auth.guard';
import { Roles } from '../../../common/decorators/roles.decorator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.interface';
import { DemoService } from './demo.service';

/** Platform admin only. Demo venues are for sales calls and never touch real data. */
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Roles('admin')
@Controller('admin/demo')
export class DemoController {
  constructor(private readonly demo: DemoService) {}

  @Get()
  list() {
    return this.demo.list();
  }

  @Post('venue')
  create(@CurrentUser() u: AuthenticatedUser) {
    return this.demo.create(u.id);
  }

  @Post(':venueId/reset')
  reset(@CurrentUser() u: AuthenticatedUser, @Param('venueId') venueId: string) {
    return this.demo.reset(u.id, venueId);
  }

  @Delete(':venueId')
  remove(@CurrentUser() u: AuthenticatedUser, @Param('venueId') venueId: string) {
    return this.demo.remove(u.id, venueId);
  }
}
