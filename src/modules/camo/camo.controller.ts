import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import { AuthGuard } from '../../common/guards/auth.guard';
import { CamoService, type CamoFeatures } from './camo.service';

@ApiTags('camo')
@Controller('camo')
export class CamoController {
  constructor(private readonly camo: CamoService) {}

  /** Public: the home card and the dashboard decide from this whether to show the game at all. */
  @Public()
  @Get('features')
  features(): CamoFeatures {
    return this.camo.features();
  }

  /** Public counts only: no names, nothing personal. */
  @Public()
  @Get('live')
  live() {
    const f = this.camo.features();
    return f.enabled ? this.camo.live() : { total: 0, matches: 0, rooms: {} };
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Get('me')
  async me() {
    return { ok: true };
  }
}
