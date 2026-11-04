import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Res,
  StreamableFile,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { createReadStream } from 'node:fs';
import { basename } from 'node:path';
import type { Response } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthGuard } from '../../../../common/guards/auth.guard';
import { Public } from '../../../../common/decorators/public.decorator';
import { Roles } from '../../../../common/decorators/roles.decorator';
import { RequirePermission } from '../../../../common/decorators/permissions.decorator';
import { CurrentUser } from '../../../../common/decorators/current-user.decorator';
import { AdminEditAuditInterceptor } from '../../../../common/interceptors/admin-edit-audit.interceptor';
import { AuthenticatedUser } from '../../../../common/types/authenticated-user.interface';
import { GamingCommandDto, GamingQueryDto } from '../gaming-operations.dto';
import { GamingHubsService } from './gaming-hubs.service';
import {
  ClaimHubDto,
  commandFrom,
  PsnLinkDto,
  RenameHubDto,
} from './gaming-devices.dto';

/** What a Matchena Hub calls (no user session: the one-time code is the credential). */
@ApiTags('gaming-hub')
@Controller('gaming/hub')
export class GamingHubClaimController {
  constructor(private readonly hubs: GamingHubsService) {}
  @Public()
  @Post('claim')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  claim(@Body() dto: ClaimHubDto) {
    return this.hubs.claim(dto);
  }

  /** Text of the PowerShell installer (Windows). */
  @Public()
  @Get('install.ps1')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  installScriptWindows(@Res({ passthrough: true }) res: Response) {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    return new StreamableFile(
      Buffer.from(this.hubs.installScriptWindows(), 'utf8'),
      {
        type: 'text/plain; charset=utf-8',
      },
    );
  }

  /** What the newest Hub release is; hubs poll this to update themselves. */
  @Public()
  @Get('latest')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  latest() {
    const release = this.hubs.latest();
    if (!release)
      throw new NotFoundException({ code: 'HUB_RELEASE_UNAVAILABLE' });
    return release;
  }

  /** Text of the one-line installer (macOS / Linux). */
  @Public()
  @Get('install.sh')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  installScript(@Res({ passthrough: true }) res: Response) {
    res.setHeader('Content-Type', 'text/x-shellscript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    return new StreamableFile(Buffer.from(this.hubs.installScript(), 'utf8'), {
      type: 'text/x-shellscript; charset=utf-8',
    });
  }

  /** The installer files, served straight from the API so the owner page never links to a missing file. */
  @Public()
  @Get('download/:file')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  download(
    @Param('file') file: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const full = this.hubs.downloadPath(file);
    if (!full)
      throw new NotFoundException({ code: 'HUB_DOWNLOAD_UNAVAILABLE' });
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${basename(full)}"`,
    );
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return new StreamableFile(createReadStream(full), {
      type: GamingHubsService.DOWNLOAD_FILES[file],
    });
  }
}

/** Owner-side hub management: connect code, rename/remove, PlayStation sign-in, rescan. */
@ApiTags('owner-gaming')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@UseInterceptors(AdminEditAuditInterceptor)
@Roles('owner', 'staff', 'admin')
@Controller('owner/gaming/devices/hub')
export class GamingHubsController {
  constructor(private readonly hubs: GamingHubsService) {}
  @Post('code') @RequirePermission('devices.manage') code(
    @CurrentUser() u: AuthenticatedUser,
    @Body() d: GamingCommandDto,
  ) {
    return this.hubs.createCode(u, d);
  }
  @Put(':hubId') @RequirePermission('devices.manage') rename(
    @CurrentUser() u: AuthenticatedUser,
    @Param('hubId', ParseUUIDPipe) id: string,
    @Body() d: RenameHubDto,
  ) {
    return this.hubs.rename(u, id, d);
  }
  @Delete(':hubId') @RequirePermission('devices.manage') remove(
    @CurrentUser() u: AuthenticatedUser,
    @Param('hubId', ParseUUIDPipe) id: string,
    @Query() q: Record<string, unknown>,
    @Body() b: Record<string, unknown>,
  ) {
    return this.hubs.remove(u, id, commandFrom(q, b));
  }
  @Post(':hubId/scan')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @RequirePermission('devices.manage')
  scan(
    @CurrentUser() u: AuthenticatedUser,
    @Param('hubId', ParseUUIDPipe) id: string,
    @Body() d: GamingCommandDto,
  ) {
    return this.hubs.scan(u, id, d);
  }
  @Post(':hubId/update')
  @Throttle({ default: { limit: 6, ttl: 60_000 } })
  @RequirePermission('devices.manage')
  update(
    @CurrentUser() u: AuthenticatedUser,
    @Param('hubId', ParseUUIDPipe) id: string,
    @Body() d: GamingCommandDto,
  ) {
    return this.hubs.update(u, id, d);
  }
  @Get(':hubId/psn-url') @RequirePermission('devices.manage') psnUrl(
    @CurrentUser() u: AuthenticatedUser,
    @Param('hubId', ParseUUIDPipe) id: string,
    @Query() q: GamingQueryDto,
  ) {
    return this.hubs.psnUrl(u, id, q.venueId);
  }
  @Post(':hubId/psn/signin')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @RequirePermission('devices.manage')
  psnSignin(
    @CurrentUser() u: AuthenticatedUser,
    @Param('hubId', ParseUUIDPipe) id: string,
    @Body() d: GamingCommandDto,
  ) {
    return this.hubs.psnSignin(u, id, d);
  }
  @Get(':hubId/psn/status')
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @RequirePermission('devices.manage')
  psnStatus(
    @CurrentUser() u: AuthenticatedUser,
    @Param('hubId', ParseUUIDPipe) id: string,
    @Query() q: GamingQueryDto,
  ) {
    return this.hubs.psnStatus(u, id, q.venueId);
  }
  @Post(':hubId/psn/cancel')
  @RequirePermission('devices.manage')
  psnCancel(
    @CurrentUser() u: AuthenticatedUser,
    @Param('hubId', ParseUUIDPipe) id: string,
    @Body() d: GamingCommandDto,
  ) {
    return this.hubs.psnCancel(u, id, d);
  }
  @Post(':hubId/psn')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @RequirePermission('devices.manage')
  psn(
    @CurrentUser() u: AuthenticatedUser,
    @Param('hubId', ParseUUIDPipe) id: string,
    @Body() d: PsnLinkDto,
  ) {
    return this.hubs.psnLink(u, id, d);
  }
}
