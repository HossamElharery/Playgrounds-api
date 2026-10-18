import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthGuard } from '../../common/guards/auth.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequireAnyPermission } from '../../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.interface';
import {
  actingOwnerId,
  venueActorPrivilege,
} from '../../common/access/actor-access';
import { PrismaService } from '../prisma/prisma.service';
import { PartnerLinksService } from './partner-links.service';
import { PartnerVisitDto } from './partner-links.dto';

@ApiTags('partner-links')
@Controller()
export class PartnerLinksController {
  constructor(
    private readonly links: PartnerLinksService,
    private readonly prisma: PrismaService,
  ) {}

  @Public()
  @Get('venues/:slug/embed')
  embed(@Param('slug') slug: string) {
    return this.links.embedCard(slug);
  }

  @Public()
  @Post('partner-visits')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  visit(@Body() dto: PartnerVisitDto, @CurrentUser() user?: AuthenticatedUser) {
    return this.links.recordVisit(dto, user?.id);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Roles('owner', 'staff', 'admin')
  @RequireAnyPermission('venue.manage', 'reports.view')
  @Get('owner/venues/:id/partner-stats')
  async stats(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    const privileged = await venueActorPrivilege(this.prisma, user, id);
    return this.links.stats(
      id,
      await actingOwnerId(this.prisma, user),
      privileged,
    );
  }
}
