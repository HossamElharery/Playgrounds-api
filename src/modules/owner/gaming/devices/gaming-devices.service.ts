import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { GamingDevice, Prisma } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { AuthenticatedUser } from '../../../../common/types/authenticated-user.interface';
import { NotificationsService } from '../../../notifications/notifications.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { GamingCommandService, jsonValue } from '../gaming-command.service';
import {
  DeviceHubHandler,
  DeviceHubService,
  DeviceRpcError,
  DEVICE_SOCKET_PREFIX,
} from './device-hub.service';
import {
  commandFor,
  deviceIntent,
  DeviceIntent,
  deviceSettings,
  DeviceSettings,
  PolicySession,
  screenFromRelay,
} from './device-policy';
import {
  modelFromDeviceId,
  safeConfigParams,
  ShellySwitchState,
  switchSetParams,
} from './shelly-protocol';
import {
  DeviceOverrideDto,
  DeviceTestDto,
  UpdateGamingDeviceDto,
} from './gaming-devices.dto';

const LOG_KEEP_DAYS = 30;
const ALERT_BUCKET_MS = 15 * 60_000;

/** What the owner screens show for one plug. */
export interface DeviceView {
  id: string;
  externalId: string;
  model: string | null;
  name: string | null;
  unitId: string | null;
  channel: number;
  settings: DeviceSettings;
  online: boolean;
  lastSeenAt: Date | null;
  screenOn: boolean | null;
  powerW: number | null;
  authError: boolean;
  override: { on: boolean; until: Date } | null;
}

export function deviceView(
  d: GamingDevice,
  online: boolean,
  now = new Date(),
): DeviceView {
  const settings = deviceSettings(d.settings);
  return {
    id: d.id,
    externalId: d.externalId,
    model: d.model,
    name: d.name,
    unitId: d.unitId,
    channel: d.channel,
    settings,
    online,
    lastSeenAt: d.lastSeenAt,
    screenOn: online ? screenFromRelay(d.output, settings) : null,
    powerW: online ? d.powerW : null,
    authError: d.authError,
    override:
      d.overrideOn !== null && d.overrideUntil && d.overrideUntil > now
        ? { on: d.overrideOn, until: d.overrideUntil }
        : null,
  };
}

/**
 * Keeps every assigned smart plug in line with its station: on while a session runs, off when it
 * ends or runs out, and — with guard on — off whenever nobody is being billed. Reconciles on every
 * gaming command, on every plug status change, and every few seconds as a safety net.
 */
@Injectable()
export class GamingDevicesService implements OnModuleInit, DeviceHubHandler {
  private readonly logger = new Logger(GamingDevicesService.name);
  private readonly busy = new Set<string>();
  private readonly lastFailure = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly hub: DeviceHubService,
    private readonly commands: GamingCommandService,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit() {
    this.hub.setHandler(this);
    // Sockets do not survive a restart; plugs re-dial within seconds and flip this back.
    void this.prisma.gamingDevice
      .updateMany({ where: { online: true }, data: { online: false } })
      .catch(() => undefined);
    this.commands.onCommitted(
      (venueId) =>
        void this.reconcileVenue(venueId).catch((e) =>
          this.logger.warn(`device reconcile failed: ${(e as Error).message}`),
        ),
    );
  }

  // ---- owner API ----

  async overview(user: AuthenticatedUser, venueId: string) {
    await this.commands.access(
      this.prisma,
      user,
      venueId,
      'devices.manage',
      false,
    );
    const token = await this.ensureToken(venueId);
    const [devices, units] = await Promise.all([
      this.prisma.gamingDevice.findMany({
        where: { venueId },
        // Stable order: a card must not jump away while the owner is linking it.
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
      this.prisma.court.findMany({
        where: {
          venueId,
          sport: { activityKind: { in: ['gaming-station', 'table-game'] } },
        },
        select: { id: true, name: true, gamingConfig: true, tableConfig: true },
        orderBy: { name: 'asc' },
      }),
    ]);
    const now = new Date();
    return {
      venueId,
      link: this.link(token),
      devices: devices.map((d) =>
        deviceView(d, this.hub.isOnline(d.externalId), now),
      ),
      units: units.map((u) => ({
        id: u.id,
        name: u.name,
        kind:
          (u.gamingConfig as { consoleType?: string } | null)?.consoleType ??
          (u.tableConfig as { tableType?: string } | null)?.tableType ??
          null,
      })),
      serverNow: now.toISOString(),
    };
  }

  rotateLink(
    user: AuthenticatedUser,
    dto: { venueId: string; requestKey: string },
  ) {
    return this.commands.command(
      user,
      'devices.manage',
      'devices.rotate-link',
      dto,
      async (tx) => {
        const token = randomBytes(24).toString('base64url');
        await tx.venue.update({
          where: { id: dto.venueId },
          data: { gamingDeviceToken: token },
        });
        const devices = await tx.gamingDevice.findMany({
          where: { venueId: dto.venueId },
          select: { externalId: true },
        });
        setTimeout(
          () => devices.forEach((d) => this.hub.disconnect(d.externalId)),
          0,
        );
        return { link: this.link(token) };
      },
    );
  }

  async update(
    user: AuthenticatedUser,
    id: string,
    dto: UpdateGamingDeviceDto,
  ) {
    const result = await this.commands.command(
      user,
      'devices.manage',
      `devices.update:${id}`,
      dto,
      async (tx) => {
        const device = await this.owned(tx, dto.venueId, id);
        if (dto.unitId) {
          const unit = await tx.court.findFirst({
            where: {
              id: dto.unitId,
              venueId: dto.venueId,
              sport: { activityKind: { in: ['gaming-station', 'table-game'] } },
            },
            select: { id: true },
          });
          if (!unit)
            throw new BadRequestException({ code: 'INVALID_GAMING_UNIT' });
        }
        const settings = dto.settings
          ? deviceSettings({
              ...deviceSettings(device.settings),
              ...dto.settings,
            })
          : deviceSettings(device.settings);
        const unitId = dto.unitId === undefined ? device.unitId : dto.unitId;
        const updated = await tx.gamingDevice.update({
          where: { id },
          data: {
            unitId,
            ...(dto.name !== undefined
              ? { name: dto.name.trim() || null }
              : {}),
            ...(dto.channel !== undefined ? { channel: dto.channel } : {}),
            settings: jsonValue(settings),
            appliedKey: null,
            ...(unitId !== device.unitId || dto.channel !== undefined
              ? { configuredAt: null }
              : {}),
          },
        });
        await tx.gamingDeviceLog.create({
          data: {
            deviceId: id,
            venueId: dto.venueId,
            kind: unitId !== device.unitId ? 'assigned' : 'settings',
            actorId: user.id,
            detail: jsonValue({ unitId, settings, channel: updated.channel }),
          },
        });
        await this.commands.event(tx, dto.venueId, id, null, 'device.changed');
        return deviceView(updated, this.hub.isOnline(updated.externalId));
      },
    );
    return result;
  }

  remove(
    user: AuthenticatedUser,
    id: string,
    dto: { venueId: string; requestKey: string },
  ) {
    return this.commands.command(
      user,
      'devices.manage',
      `devices.remove:${id}`,
      dto,
      async (tx) => {
        const device = await this.owned(tx, dto.venueId, id);
        await tx.gamingDevice.delete({ where: { id } });
        await this.commands.event(tx, dto.venueId, id, null, 'device.changed');
        setTimeout(() => this.hub.disconnect(device.externalId), 0);
        return { id };
      },
    );
  }

  /** Power the screen for a few seconds so the owner can see which plug is which. */
  async test(user: AuthenticatedUser, id: string, dto: DeviceTestDto) {
    await this.commands.command(
      user,
      'devices.manage',
      `devices.test:${id}`,
      dto,
      async (tx, now) => {
        await this.owned(tx, dto.venueId, id);
        await tx.gamingDevice.update({
          where: { id },
          data: {
            overrideOn: true,
            overrideUntil: new Date(now.getTime() + dto.seconds * 1000),
            overrideBy: user.id,
            appliedKey: null,
          },
        });
        await tx.gamingDeviceLog.create({
          data: {
            deviceId: id,
            venueId: dto.venueId,
            kind: 'test',
            actorId: user.id,
            detail: { seconds: dto.seconds },
          },
        });
        return { id };
      },
    );
    return this.applyNow(dto.venueId, id);
  }

  /** Force the screen on or off for a while (setup, repairs, a plug that misbehaves). */
  async override(user: AuthenticatedUser, id: string, dto: DeviceOverrideDto) {
    await this.commands.command(
      user,
      'devices.manage',
      `devices.override:${id}`,
      dto,
      async (tx, now) => {
        await this.owned(tx, dto.venueId, id);
        if (dto.minutes > 0 && !dto.reason?.trim())
          throw new BadRequestException({ code: 'REASON_REQUIRED' });
        const clear = dto.minutes === 0;
        await tx.gamingDevice.update({
          where: { id },
          data: clear
            ? {
                overrideOn: null,
                overrideUntil: null,
                overrideBy: null,
                appliedKey: null,
              }
            : {
                overrideOn: dto.on,
                overrideUntil: new Date(now.getTime() + dto.minutes * 60_000),
                overrideBy: user.id,
                appliedKey: null,
              },
        });
        await tx.gamingDeviceLog.create({
          data: {
            deviceId: id,
            venueId: dto.venueId,
            kind: 'override',
            actorId: user.id,
            detail: clear
              ? { cleared: true }
              : {
                  on: dto.on,
                  minutes: dto.minutes,
                  reason: dto.reason?.trim(),
                },
          },
        });
        return { id };
      },
    );
    return this.applyNow(dto.venueId, id);
  }

  async logs(user: AuthenticatedUser, venueId: string, id: string) {
    await this.commands.access(
      this.prisma,
      user,
      venueId,
      'devices.manage',
      false,
    );
    await this.owned(this.prisma, venueId, id);
    const rows = await this.prisma.gamingDeviceLog.findMany({
      where: { deviceId: id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return {
      items: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        detail: r.detail,
        actorId: r.actorId,
        createdAt: r.createdAt,
      })),
    };
  }

  // ---- hub callbacks ----

  async connected(venueId: string, deviceId: string) {
    const now = new Date();
    const existing = await this.prisma.gamingDevice.findUnique({
      where: {
        provider_externalId: { provider: 'shelly', externalId: deviceId },
      },
    });
    const moved = existing && existing.venueId !== venueId;
    const device = existing
      ? await this.prisma.gamingDevice.update({
          where: { id: existing.id },
          data: {
            online: true,
            lastSeenAt: now,
            appliedKey: null,
            configuredAt: null,
            ...(moved
              ? { venueId, unitId: null, overrideOn: null, overrideUntil: null }
              : {}),
          },
        })
      : await this.prisma.gamingDevice.create({
          data: {
            venueId,
            provider: 'shelly',
            externalId: deviceId,
            model: modelFromDeviceId(deviceId),
            settings: jsonValue(deviceSettings(null)),
            online: true,
            lastSeenAt: now,
          },
        });
    await this.log(
      device,
      'connected',
      moved ? { movedFrom: existing.venueId } : null,
    );
    await this.changed(venueId, device.id);
  }

  async status(
    venueId: string,
    deviceId: string,
    _full: boolean,
    switches: ShellySwitchState[],
  ) {
    const device = await this.prisma.gamingDevice.findUnique({
      where: {
        provider_externalId: { provider: 'shelly', externalId: deviceId },
      },
    });
    if (!device || device.venueId !== venueId) return;
    const sw = switches.find((s) => s.channel === device.channel);
    const data: Prisma.GamingDeviceUpdateInput = {
      online: true,
      lastSeenAt: new Date(),
    };
    if (sw?.output !== undefined) data.output = sw.output;
    if (sw?.powerW !== undefined) data.powerW = Math.round(sw.powerW * 10) / 10;
    // Plugs report power every few seconds; only write what the screens would show differently.
    const outputChanged =
      sw?.output !== undefined && sw.output !== device.output;
    const powerMoved =
      sw?.powerW !== undefined &&
      Math.abs((device.powerW ?? 0) - sw.powerW) >= 2;
    const stale =
      !device.lastSeenAt || Date.now() - device.lastSeenAt.getTime() > 60_000;
    if (!outputChanged && !powerMoved && !stale && device.online) return;
    const updated = await this.prisma.gamingDevice.update({
      where: { id: device.id },
      data,
    });
    if (sw?.output !== undefined && sw.output !== device.output) {
      await this.changed(venueId, device.id);
      await this.reconcileVenue(venueId, sw.source);
    } else if (
      sw?.powerW !== undefined &&
      Math.abs((device.powerW ?? 0) - (updated.powerW ?? 0)) >= 5
    ) {
      await this.changed(venueId, device.id);
    }
  }

  async disconnected(venueId: string, deviceId: string) {
    const device = await this.prisma.gamingDevice.findUnique({
      where: {
        provider_externalId: { provider: 'shelly', externalId: deviceId },
      },
    });
    if (!device || device.venueId !== venueId) return;
    await this.prisma.gamingDevice.update({
      where: { id: device.id },
      data: { online: false },
    });
    await this.log(device, 'disconnected', null);
    await this.changed(venueId, device.id);
    if (
      device.unitId &&
      (await this.prisma.usageSession.count({
        where: { unitId: device.unitId, state: 'running' },
      }))
    ) {
      await this.alert(
        device,
        'offline',
        'الفيشة فصلت أثناء جلسة',
        'Plug went offline during a session',
        'الشاشة هتفضل على آخر حالة، والفيشة هتطفي لوحدها في ميعاد الجلسة لو الوقت محدد. راجع الواي فاي.',
        'The screen keeps its last state and a timed session still switches off on time. Check the Wi-Fi.',
      );
    }
  }

  // ---- reconcile ----

  @Cron('*/5 * * * * *')
  async sweep() {
    const ids = this.hub.connectedIds();
    if (!ids.length) return;
    const venues = await this.prisma.gamingDevice.findMany({
      where: {
        provider: 'shelly',
        externalId: { in: ids },
        unitId: { not: null },
      },
      select: { venueId: true },
      distinct: ['venueId'],
    });
    for (const v of venues)
      await this.reconcileVenue(v.venueId).catch((e) =>
        this.logger.warn(`device sweep failed: ${(e as Error).message}`),
      );
  }

  @Cron('0 17 4 * * *')
  async prune() {
    await this.prisma.gamingDeviceLog.deleteMany({
      where: {
        createdAt: { lt: new Date(Date.now() - LOG_KEEP_DAYS * 86_400_000) },
      },
    });
  }

  async reconcileVenue(venueId: string, source?: string, now = new Date()) {
    const devices = await this.prisma.gamingDevice.findMany({
      where: { venueId, unitId: { not: null }, provider: 'shelly' },
      include: {
        unit: {
          select: {
            id: true,
            gamingRoom: { select: { occupancy: true, bookableCourtId: true } },
          },
        },
      },
    });
    const live = devices.filter((d) => this.hub.isOnline(d.externalId));
    if (!live.length) return;
    const sessions = await this.prisma.usageSession.findMany({
      where: { venueId, state: 'running' },
      select: { unitId: true, expectedEnd: true },
    });
    for (const device of live) {
      const room = device.unit?.gamingRoom;
      const session =
        sessions.find((s) => s.unitId === device.unitId) ??
        (room?.occupancy === 'exclusive' && room.bookableCourtId
          ? sessions.find((s) => s.unitId === room.bookableCourtId)
          : undefined) ??
        null;
      await this.apply(device, session, now, source);
    }
  }

  /** Reconcile one plug right away and report whether the plug accepted the command. */
  private async applyNow(venueId: string, id: string) {
    const device = await this.prisma.gamingDevice.findFirst({
      where: { id, venueId },
      include: {
        unit: {
          select: {
            id: true,
            gamingRoom: { select: { occupancy: true, bookableCourtId: true } },
          },
        },
      },
    });
    if (!device)
      throw new ForbiddenException({ code: 'DEVICE_NOT_ACCESSIBLE' });
    if (!this.hub.isOnline(device.externalId))
      return { ok: false, error: 'offline', device: deviceView(device, false) };
    const room = device.unit?.gamingRoom;
    const units = [
      device.unitId,
      room?.occupancy === 'exclusive' ? room.bookableCourtId : null,
    ].filter((x): x is string => !!x);
    const session = units.length
      ? await this.prisma.usageSession.findFirst({
          where: { unitId: { in: units }, state: 'running' },
          orderBy: { startedAt: 'desc' },
          select: { expectedEnd: true },
        })
      : null;
    let outcome = await this.apply(
      device,
      session,
      new Date(),
      undefined,
      true,
    );
    for (let i = 0; outcome === 'busy' && i < 20; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const latest = await this.prisma.gamingDevice.findUniqueOrThrow({
        where: { id },
      });
      outcome = await this.apply(latest, session, new Date(), undefined, true);
    }
    const fresh = await this.prisma.gamingDevice.findUniqueOrThrow({
      where: { id },
    });
    return {
      ok: outcome !== 'failed',
      error:
        outcome === 'failed' ? (fresh.authError ? 'auth' : 'device') : null,
      device: deviceView(fresh, this.hub.isOnline(fresh.externalId)),
    };
  }

  private async apply(
    device: GamingDevice,
    session: PolicySession | null,
    now: Date,
    source?: string,
    unassignedOk = false,
  ): Promise<'sent' | 'idle' | 'failed' | 'busy'> {
    if (this.busy.has(device.id)) return 'busy';
    if (!device.unitId && !unassignedOk) return 'idle';
    this.busy.add(device.id);
    try {
      const settings = deviceSettings(device.settings);
      const override =
        device.overrideOn !== null && device.overrideUntil
          ? { on: device.overrideOn, until: device.overrideUntil }
          : null;
      const intent = deviceIntent(
        settings,
        device.unitId ? session : null,
        override,
        now,
      );
      if (intent.screenOn !== null && !device.configuredAt)
        await this.configure(device);
      const reported = screenFromRelay(device.output, settings);
      const plan = commandFor(
        intent,
        settings,
        device.appliedKey,
        reported,
        now,
      );
      if (!plan) return 'idle';
      const guardFired =
        intent.enforce &&
        intent.key === device.appliedKey &&
        reported === true &&
        intent.screenOn === false;
      await this.hub.call(
        device.externalId,
        'Switch.Set',
        switchSetParams(device.channel, plan.on, plan.toggleAfter),
      );
      await this.prisma.gamingDevice.update({
        where: { id: device.id },
        data: {
          appliedKey: intent.key,
          output: plan.on,
          authError: false,
          ...(override && override.until <= now
            ? { overrideOn: null, overrideUntil: null, overrideBy: null }
            : {}),
        },
      });
      this.lastFailure.delete(device.id);
      await this.log(device, guardFired ? 'guard' : 'command', {
        screenOn: intent.screenOn,
        reason: intent.reason,
        toggleAfter: plan.toggleAfter,
        ...(source ? { source } : {}),
      });
      await this.changed(device.venueId, device.id);
      if (guardFired)
        await this.alert(
          device,
          'guard',
          'شاشة اشتغلت من غير جلسة',
          'Screen switched on without a session',
          'Matchena طفاها تاني. لو محتاج تشغّلها، ابدأ جلسة أو استخدم التشغيل اليدوي من إعدادات الشاشة.',
          'Matchena switched it off again. Start a session, or use a manual override in the screen settings.',
        );
      return 'sent';
    } catch (error) {
      const code = error instanceof DeviceRpcError ? error.code : 'device';
      if (code === 'auth' && !device.authError)
        await this.prisma.gamingDevice.update({
          where: { id: device.id },
          data: { authError: true },
        });
      const last = this.lastFailure.get(device.id) ?? 0;
      if (Date.now() - last > 60_000) {
        this.lastFailure.set(device.id, Date.now());
        await this.log(device, 'failed', {
          code,
          message: (error as Error).message.slice(0, 200),
        });
        if (code === 'auth') await this.changed(device.venueId, device.id);
      }
      return 'failed';
    } finally {
      this.busy.delete(device.id);
    }
  }

  private async configure(device: GamingDevice) {
    try {
      await this.hub.call(
        device.externalId,
        'Switch.SetConfig',
        safeConfigParams(device.channel),
      );
      await this.prisma.gamingDevice.update({
        where: { id: device.id },
        data: { configuredAt: new Date() },
      });
      device.configuredAt = new Date();
    } catch (error) {
      if (error instanceof DeviceRpcError && error.code === 'auth') throw error;
      // Older firmware without initial_state: control still works, only the power-cut safety is missing.
      this.logger.debug(
        `device config skipped ${device.externalId}: ${(error as Error).message}`,
      );
    }
  }

  // ---- helpers ----

  private async owned(
    db: Prisma.TransactionClient | PrismaService,
    venueId: string,
    id: string,
  ) {
    const device = await db.gamingDevice.findFirst({ where: { id, venueId } });
    if (!device)
      throw new ForbiddenException({ code: 'DEVICE_NOT_ACCESSIBLE' });
    return device;
  }

  private async ensureToken(venueId: string) {
    const venue = await this.prisma.venue.findUniqueOrThrow({
      where: { id: venueId },
      select: { gamingDeviceToken: true },
    });
    if (venue.gamingDeviceToken) return venue.gamingDeviceToken;
    const token = randomBytes(24).toString('base64url');
    const updated = await this.prisma.venue.updateMany({
      where: { id: venueId, gamingDeviceToken: null },
      data: { gamingDeviceToken: token },
    });
    if (updated.count) return token;
    return (
      await this.prisma.venue.findUniqueOrThrow({
        where: { id: venueId },
        select: { gamingDeviceToken: true },
      })
    ).gamingDeviceToken!;
  }

  /**
   * wss://<api host>/api/v1/gaming/devices/shelly/<token>. Plugs dial the API host directly (the
   * web origin's /api proxy is not guaranteed to pass WebSocket upgrades).
   */
  link(token: string) {
    const configured =
      this.config.get<string>('DEVICE_PUBLIC_URL')?.trim() ||
      this.config.get<string>('API_PUBLIC_URL')?.trim();
    const fallback =
      this.config.get<string>('NODE_ENV') === 'production'
        ? 'https://api.matchena.com'
        : `http://localhost:${this.config.get<number>('PORT', 3000)}`;
    let url: URL;
    try {
      url = new URL((configured || fallback).replace(/\/+$/, ''));
    } catch {
      url = new URL(fallback);
    }
    const scheme = url.protocol === 'http:' ? 'ws' : 'wss';
    return {
      url: `${scheme}://${url.host}${DEVICE_SOCKET_PREFIX}${token}`,
      host: url.host,
      secure: scheme === 'wss',
    };
  }

  private async log(
    device: GamingDevice,
    kind: string,
    detail: Record<string, unknown> | null,
  ) {
    await this.prisma.gamingDeviceLog
      .create({
        data: {
          deviceId: device.id,
          venueId: device.venueId,
          kind,
          ...(detail ? { detail: jsonValue(detail) } : {}),
        },
      })
      .catch(() => undefined);
  }

  private async changed(venueId: string, deviceId: string) {
    await this.commands
      .event(
        this.prisma as unknown as Prisma.TransactionClient,
        venueId,
        deviceId,
        null,
        'device.changed',
      )
      .catch(() => undefined);
  }

  private async alert(
    device: GamingDevice,
    kind: string,
    titleAr: string,
    titleEn: string,
    bodyAr: string,
    bodyEn: string,
  ) {
    const venue = await this.prisma.venue.findUnique({
      where: { id: device.venueId },
      select: { ownerId: true, nameAr: true, nameEn: true },
    });
    if (!venue) return;
    const unit = device.unitId
      ? await this.prisma.court.findUnique({
          where: { id: device.unitId },
          select: { name: true },
        })
      : null;
    const staff = await this.prisma.staffMember.findMany({
      where: {
        user: { roles: { has: 'staff' }, status: 'active' },
        ownerId: venue.ownerId,
        venueIds: { has: device.venueId },
        permissions: { has: 'sessions.end' },
      },
      select: { userId: true },
    });
    const bucket = Math.floor(Date.now() / ALERT_BUCKET_MS);
    const label = unit?.name ?? device.name ?? device.externalId;
    for (const userId of new Set([
      venue.ownerId,
      ...staff.map((s) => s.userId),
    ])) {
      await this.notifications
        .create({
          dedupKey: `gaming-device:${kind}:${device.id}:${bucket}:${userId}`,
          userId,
          category: 'system',
          titleAr: `${venue.nameAr}: ${titleAr} (${label})`,
          titleEn: `${venue.nameEn}: ${titleEn} (${label})`,
          bodyAr,
          bodyEn,
          deepLink: '/owner/gaming',
          payload: {
            venueId: device.venueId,
            deviceId: device.id,
            unitId: device.unitId,
          },
        })
        .catch(() => undefined);
    }
  }
}

export type { DeviceIntent };
