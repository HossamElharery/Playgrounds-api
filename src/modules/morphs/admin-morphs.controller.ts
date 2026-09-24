import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { AuthGuard } from '../../common/guards/auth.guard';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.interface';
import { MorphsEnabledGuard } from './morphs-enabled.guard';
import { MorphsService } from './morphs.service';
import { GrantMorphDto, MorphStatsQueryDto } from './dto/admin-morphs.dto';

@ApiTags('admin-morphs')
@ApiBearerAuth()
@UseGuards(AuthGuard, MorphsEnabledGuard)
@Roles('admin')
@Controller('admin/morphs')
export class AdminMorphsController {
  constructor(private readonly morphs: MorphsService) {}

  @Post('grant')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  grant(@CurrentUser() admin: AuthenticatedUser, @Body() dto: GrantMorphDto) {
    return this.morphs.grant(admin.id, dto.userId, dto.morphId);
  }

  @Get('stats')
  stats(@Query() query: MorphStatsQueryDto) {
    return this.morphs.stats(query.days ?? 7);
  }
}
