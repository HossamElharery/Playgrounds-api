import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';
import { AuthGuard } from '../../../common/guards/auth.guard';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.interface';
import { RewardsRiskService } from './rewards-risk.service';
import { TrustService } from './trust.service';

class FreezeVenueDto {
  @IsBoolean() on!: boolean;
  @IsOptional() @IsBoolean() revokeRecent?: boolean;
}

class RevokeDto {
  @IsOptional() @IsBoolean() clawback?: boolean;
  @IsOptional() @IsBoolean() block?: boolean;
}

class BlockDto {
  @IsBoolean() on!: boolean;
}

@ApiTags('rewards-risk')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Roles('admin')
@Controller('admin/rewards-risk')
export class RewardsRiskController {
  constructor(
    private readonly risk: RewardsRiskService,
    private readonly trust: TrustService,
  ) {}

  @Get('overview')
  overview() {
    return this.risk.overview();
  }

  @Post('venues/:id/freeze')
  freezeVenue(@CurrentUser() admin: AuthenticatedUser, @Param('id') id: string, @Body() dto: FreezeVenueDto) {
    return this.trust.setVenueFrozen(id, admin.id, dto.on, dto.revokeRecent ?? false);
  }

  @Post('users/:id/revoke')
  revoke(@CurrentUser() admin: AuthenticatedUser, @Param('id') id: string, @Body() dto: RevokeDto) {
    return this.trust.revoke(id, admin.id, { clawback: dto.clawback ?? true, block: dto.block ?? true });
  }

  @Post('users/:id/trust')
  async trustUser(@CurrentUser() admin: AuthenticatedUser, @Param('id') id: string) {
    return { trusted: await this.trust.adminTrust(id, admin.id) };
  }

  @Post('users/:id/block')
  async block(@CurrentUser() admin: AuthenticatedUser, @Param('id') id: string, @Body() dto: BlockDto) {
    await this.trust.setBlocked(id, admin.id, dto.on);
    return { blocked: dto.on };
  }
}
