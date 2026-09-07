import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../../common/guards/auth.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.interface';
import { AdminService } from './admin.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CreateReportDto } from './dto/create-report.dto';
import { BroadcastNotificationDto } from './dto/broadcast-notification.dto';
import { ResolveReportDto } from './dto/resolve-report.dto';
import { UpsertFeatureFlagDto } from './dto/feature-flag.dto';
import { PageQueryDto } from '../../common/dto/page-query.dto';
import { ListReportsQueryDto } from './dto/list-reports-query.dto';

@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller()
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly notifications: NotificationsService,
  ) {}

  // Any authenticated user can file a report.
  @Post('reports')
  createReport(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateReportDto,
  ) {
    return this.admin.createReport(user.id, dto);
  }

  @Roles('admin')
  @Get('admin/overview')
  overview() {
    return this.admin.overview();
  }

  @Roles('admin')
  @Post('admin/notifications/broadcast')
  broadcast(@Body() dto: BroadcastNotificationDto) {
    return this.notifications.broadcast(dto);
  }

  @Roles('admin')
  @Get('admin/moderation/reports')
  async listReports(@Query() q: ListReportsQueryDto) {
    const { items, pagination } = await this.admin.listReports(
      q.page,
      q.perPage,
      q.status,
    );
    return { message: 'ok', result: items, pagination };
  }

  @Roles('admin')
  @Patch('admin/moderation/reports/:id')
  resolveReport(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ResolveReportDto,
  ) {
    return this.admin.resolveReport(user.id, id, dto);
  }

  @Roles('admin')
  @Get('admin/audit-log')
  async auditLog(@Query() q: PageQueryDto) {
    const { items, pagination } = await this.admin.listAuditLog(
      q.page,
      q.perPage,
    );
    return { message: 'ok', result: items, pagination };
  }

  @Roles('admin')
  @Get('admin/feature-flags')
  listFlags() {
    return this.admin.listFeatureFlags();
  }

  @Roles('admin')
  @Post('admin/feature-flags')
  upsertFlag(@Body() dto: UpsertFeatureFlagDto) {
    return this.admin.upsertFeatureFlag(dto);
  }

  @Roles('admin')
  @Get('admin/analytics/funnel')
  funnel() {
    return this.admin.searchFunnel();
  }

  @Roles('admin')
  @Get('admin/analytics/cohorts')
  cohorts() {
    return this.admin.cohortRetention();
  }
}
