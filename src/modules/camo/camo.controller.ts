import { Controller, Get, Header, HttpStatus, Param, UseGuards } from '@nestjs/common';
import { ApiException } from '../../common/errors/api-exception';
import { roomHash } from './camo-room';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import { AuthGuard } from '../../common/guards/auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.interface';
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

  /** The authoritative room file (colliders, hide spots, props). The client builds its scene and prediction from it. */
  @Public()
  @Get('rooms/:id')
  @Header('Cache-Control', 'public, max-age=300')
  room(@Param('id') id: string) {
    const room = this.camo.host.roomData(id);
    if (!room) throw new ApiException(HttpStatus.NOT_FOUND, 'CAMO_ROOM_UNKNOWN', 'Unknown room');
    return { ...room, hash: roomHash(room) };
  }

  /** Public link-preview data: the room and the counts, never the hider. */
  @Public()
  @Get('challenges/:id')
  async challenge(@Param('id') id: string) {
    const info = await this.camo.puzzles.publicInfo(id);
    if (!info) throw new ApiException(HttpStatus.NOT_FOUND, 'CAMO_CHALLENGE_UNKNOWN', 'This challenge is gone');
    return info;
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Get('my/challenges')
  mine(@CurrentUser() user: AuthenticatedUser) {
    return this.camo.puzzles.mine(user.id);
  }

  @Public()
  @Get('daily')
  async daily() {
    if (!this.camo.features().daily) return { enabled: false };
    const t = await this.camo.puzzles.today(this.camo.host);
    return { enabled: true, day: t.day, roomId: t.roomId, board: await this.camo.puzzles.board(t.day, 10) };
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Get('me')
  async me() {
    return { ok: true };
  }
}
