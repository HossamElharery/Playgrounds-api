import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../../common/guards/auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.interface';
import { NotificationsService } from './notifications.service';
import {
  RegisterDeviceTokenDto,
  UpdateNotificationPrefsDto,
} from './dto/device-token.dto';
import { clampLimit } from '../../common/utils/page-limit.util';

@ApiTags('notifications')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.notifications.list(user.id, cursor, clampLimit(limit, 30, 100));
  }

  @Get('unread-count')
  async unreadCount(@CurrentUser() user: AuthenticatedUser) {
    return { count: await this.notifications.unreadCount(user.id) };
  }

  @Get('preferences')
  preferences(@CurrentUser() user: AuthenticatedUser) {
    return this.notifications.getPreferences(user.id);
  }

  @Patch('preferences')
  updatePreferences(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateNotificationPrefsDto,
  ) {
    return this.notifications.updatePreferences(user.id, dto);
  }

  @Post('device-tokens')
  registerDevice(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RegisterDeviceTokenDto,
  ) {
    return this.notifications.registerDevice(
      user.id,
      dto.token,
      dto.platform ?? 'web',
    );
  }

  @Delete('device-tokens')
  unregisterDevice(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RegisterDeviceTokenDto,
  ) {
    return this.notifications.unregisterDevice(user.id, dto.token);
  }

  @Patch('read-all')
  markAllRead(@CurrentUser() user: AuthenticatedUser) {
    return this.notifications.markAllRead(user.id);
  }

  @Delete(':id')
  dismiss(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.notifications.dismiss(user.id, id);
  }

  @Patch(':id/read')
  markRead(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.notifications.markRead(user.id, id);
  }
}
