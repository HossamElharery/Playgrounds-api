import { Body, Controller, Get, Header, HttpStatus, Param, Post, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { renderChallengeOg } from './camo-og';
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

  /**
   * The 1200x630 preview card for a challenge link. An unknown or finished challenge gets the plain card, so the
   * response never says whether an id exists, and nothing in it depends on where the hider is.
   */
  @Public()
  @Get('challenges/:id/og.jpg')
  async challengeOg(@Param('id') id: string, @Res() res: Response) {
    const info = await this.camo.puzzles.publicInfo(id).catch(() => null);
    const jpg = await renderChallengeOg(info?.roomId ?? 'locker_room', info?.attempts ?? 0, info?.found ?? 0);
    res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=900, s-maxage=900', 'Cross-Origin-Resource-Policy': 'cross-origin' });
    res.send(jpg);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Get('my/progress')
  progress(@CurrentUser() user: AuthenticatedUser) {
    return this.camo.progress.me(user.id);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Post('my/cosmetics/:id/buy')
  async buy(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.camo.progress.buy(user.id, id).catch(() => ({ ok: false as const, reason: 'coins' as const }));
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Post('my/cosmetics/equip')
  equip(@CurrentUser() user: AuthenticatedUser, @Body() body: { kind?: string; id?: string | null }) {
    const kinds = ['red_card_anim', 'var_frame', 'name_style', 'win_dance', 'taunt_sound'];
    if (!kinds.includes(body?.kind ?? '')) return { ok: false };
    return this.camo.progress.equip(user.id, body.kind as never, body.id ?? null);
  }

  @Public()
  @Get('board')
  board() {
    return this.camo.progress.board();
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

  /** The daily board for the viewer's own governorate; `governorate: null` when the account has none yet. */
  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Get('daily/governorate')
  async dailyGovernorate(@CurrentUser() user: AuthenticatedUser) {
    if (!this.camo.features().daily) return { enabled: false };
    const t = await this.camo.puzzles.today(this.camo.host);
    const gov = await this.camo.puzzles.governorateOf(user.id);
    return { enabled: true, day: t.day, governorate: gov ? { nameAr: gov.nameAr, nameEn: gov.nameEn } : null, board: gov ? await this.camo.puzzles.boardForGovernorate(t.day, gov.id, 10) : [] };
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @Get('me')
  async me() {
    return { ok: true };
  }
}
