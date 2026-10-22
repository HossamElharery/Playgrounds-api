import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { AuthGuard } from '../../common/guards/auth.guard';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.interface';
import { CAMO_DEFAULTS, CamoSettingsService, type CamoSettings } from './camo-settings.service';
import { CamoService } from './camo.service';

const ACTIONS = ['ignore', 'warn', 'voice_restrict', 'force_rename', 'camo_ban'] as const;

/** The «استغماية» admin tab: report queue, live rooms, audit log, settings. Admin only. */
@ApiTags('camo-admin')
@ApiBearerAuth()
@Controller('admin/camo')
@UseGuards(AuthGuard)
@Roles('admin')
export class CamoAdminController {
  constructor(
    private readonly camo: CamoService,
    private readonly settings: CamoSettingsService,
  ) {}

  /** Live numbers, the flags as the game sees them and every tunable value. */
  @Get('overview')
  async overview() {
    const rooms = this.camo.host.liveRooms();
    const humans = rooms.reduce((n, r) => n + r.humans.length, 0);
    const bots = rooms.reduce((n, r) => n + r.bots, 0);
    return {
      flags: this.camo.features(),
      overrides: (await this.settings.load()).flags,
      live: { matches: rooms.length, humans, bots, botRatio: humans + bots ? Math.round((bots / (humans + bots)) * 100) / 100 : 0 },
      settings: await this.settings.load(),
    };
  }

  @Put('settings/:key')
  async setSetting(@CurrentUser() admin: AuthenticatedUser, @Param('key') key: string, @Body() body: { value?: unknown }) {
    if (!(key in CAMO_DEFAULTS) || body?.value === undefined) return { ok: false, reason: 'unknown_key' };
    const expected = typeof (CAMO_DEFAULTS as Record<string, unknown>)[key];
    if (expected !== 'object' && typeof body.value !== expected) return { ok: false, reason: 'bad_type' };
    await this.settings.set(key as keyof CamoSettings, body.value, admin.id);
    await this.camo.moderation.logAdmin(admin.id, `setting.${key}`, null, { value: body.value as never });
    return { ok: true };
  }

  @Get('reports')
  reports(@Query('status') status?: string) {
    return this.camo.moderation.queue(status === 'done' ? 'done' : 'open');
  }

  @Post('reports/:id/act')
  @HttpCode(HttpStatus.OK)
  act(@CurrentUser() admin: AuthenticatedUser, @Param('id') id: string, @Body() body: { action?: string; hours?: number | null }) {
    const action = ACTIONS.find((a) => a === body?.action);
    if (!action) return { ok: false, reason: 'bad_action' };
    return this.camo.moderation.act(admin.id, id, action, typeof body.hours === 'number' ? Math.min(24 * 365, Math.max(1, body.hours)) : null);
  }

  /** Names and counts only: no positions, so the live view cannot be used to find hiders. */
  @Get('rooms')
  rooms() {
    return { rooms: this.camo.host.liveRooms(), draining: this.camo.features().drain };
  }

  @Post('rooms/:id/kick')
  @HttpCode(HttpStatus.OK)
  async kick(@CurrentUser() admin: AuthenticatedUser, @Param('id') id: string, @Body() body: { userId?: string }) {
    const ok = !!body?.userId && this.camo.host.adminKick(id, body.userId);
    if (ok) await this.camo.moderation.logAdmin(admin.id, 'room.kick', body.userId ?? null, { matchId: id });
    return { ok };
  }

  @Post('rooms/:id/close')
  @HttpCode(HttpStatus.OK)
  async close(@CurrentUser() admin: AuthenticatedUser, @Param('id') id: string) {
    const ok = this.camo.host.adminCloseRoom(id);
    if (ok) await this.camo.moderation.logAdmin(admin.id, 'room.close', null, { matchId: id });
    return { ok };
  }

  /** The admin picks (or replaces) the daily Chameleon from any challenge. */
  @Put('daily/:day')
  async setDaily(@CurrentUser() admin: AuthenticatedUser, @Param('day') day: string, @Body() body: { fromPuzzleId?: string }) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !body?.fromPuzzleId) return { ok: false, reason: 'bad_input' };
    const ok = await this.camo.puzzles.setDaily(day, body.fromPuzzleId);
    if (ok) await this.camo.moderation.logAdmin(admin.id, 'daily.set', null, { day, from: body.fromPuzzleId });
    return { ok };
  }

  @Get('audit')
  audit() {
    return this.camo.moderation.audit();
  }
}
