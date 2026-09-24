import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthGuard } from '../../common/guards/auth.guard';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.interface';
import { MORPH_CATALOG_VERSION } from './morph-catalog';
import { MorphsEnabledGuard } from './morphs-enabled.guard';
import { MorphsService } from './morphs.service';
import { RollMorphDto } from './dto/roll-morph.dto';
import { EquipMorphDto } from './dto/equip-morph.dto';
import { MarkMorphsSeenDto } from './dto/mark-seen.dto';

@ApiTags('morphs')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('morphs')
export class MorphsController {
  constructor(private readonly morphs: MorphsService) {}

  @Public()
  @UseGuards(MorphsEnabledGuard)
  @Get('catalog')
  @Header('Cache-Control', 'public, max-age=300')
  @Header('ETag', `"morph-catalog-v${MORPH_CATALOG_VERSION}"`)
  catalog() {
    return this.morphs.catalog();
  }

  /** Stays 200 with `{ enabled: false }` while the flag is off so the client can hide the UI cleanly. */
  @Get('me')
  me(@CurrentUser() user: AuthenticatedUser) {
    return this.morphs.me(user.id);
  }

  @UseGuards(MorphsEnabledGuard)
  @Post('roll')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 40, ttl: 60_000 } })
  roll(@CurrentUser() user: AuthenticatedUser, @Body() dto: RollMorphDto) {
    return this.morphs.roll(user.id, dto.clientRollId);
  }

  @UseGuards(MorphsEnabledGuard)
  @Post('equip')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  equip(@CurrentUser() user: AuthenticatedUser, @Body() dto: EquipMorphDto) {
    return this.morphs.equip(user.id, dto.morphId);
  }

  @UseGuards(MorphsEnabledGuard)
  @Post('seen')
  @HttpCode(HttpStatus.OK)
  markSeen(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: MarkMorphsSeenDto,
  ) {
    return this.morphs.markSeen(user.id, dto.morphIds);
  }
}
