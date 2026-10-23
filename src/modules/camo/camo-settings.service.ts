import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** The numbers the owner may tune from the admin tab (section 18): none of them is hard-coded in a rule. */
export const CAMO_DEFAULTS = Object.freeze({
  guestPerIpPerDay: 10,
  guestPerDevicePerDay: 3,
  /** Sanction ladder (section 17a-5). */
  warnAfterReports: 3,
  voiceRestrictAfterReports: 5,
  reportWindowHours: 24,
  voiceRestrictHours: 24,
  voiceRestrictRepeatDays: 30,
  voiceRestrictRepeatHours: 24 * 7,
  hideNameAfterReports: 2,
  reportsPerHour: 10,
  /** Votes. */
  muteVoteSeconds: 20,
  muteVoteMinYes: 2,
  kickVotePct: 0.6,
  kickVoteMinYes: 3,
  voteCooldownSeconds: 180,
  noVoteLastSeconds: 20,
  /** Progress and rewards (section 16): all tunable, none hard-coded in a rule. */
  xpPerMatch: 20,
  xpWinBonus: 40,
  xpPerRedCard: 5,
  xpPerSurvivedRound: 8,
  coinsPerMatch: 8,
  coinsWinBonus: 8,
  coinsDailyCap: 100,
  missionCoins: 15,
  /** Gameplay switches. */
  scanEnabled: true,
  maxMatches: 40,
  camoUnsupported: [] as string[],
  /** Rooms players can be matched into (the admin tab turns the M2 rooms on). */
  enabledRooms: ['warehouse', 'locker_room'] as string[],
  /** Runtime flag overrides from the admin tab (CAMO_ENABLED etc. as 'true'/'false'); empty = the environment decides. */
  flags: {} as Record<string, string>,
});

export type CamoSettings = typeof CAMO_DEFAULTS;

@Injectable()
export class CamoSettingsService {
  private readonly logger = new Logger(CamoSettingsService.name);
  private cache: { at: number; values: Partial<CamoSettings> } = { at: 0, values: {} };

  constructor(private readonly prisma: PrismaService) {}

  async load(force = false): Promise<CamoSettings> {
    const now = Date.now();
    if (!force && now - this.cache.at < 30_000) return { ...CAMO_DEFAULTS, ...this.cache.values };
    try {
      const rows = await this.prisma.camoSetting.findMany();
      const values: Record<string, unknown> = {};
      for (const r of rows) values[r.key] = r.value;
      this.cache = { at: now, values: values as Partial<CamoSettings> };
    } catch (err) {
      this.logger.warn(`camo settings unreadable, using defaults: ${err instanceof Error ? err.message : err}`);
      this.cache = { at: now, values: this.cache.values };
    }
    return { ...CAMO_DEFAULTS, ...this.cache.values };
  }

  /** A `ConfigService`-shaped reader: the admin override wins, the environment is the fallback. */
  flagSource(env: { get<T = string>(key: string): T | undefined }): { get<T = string>(key: string): T | undefined } {
    return { get: <T = string>(key: string): T | undefined => (this.current.flags?.[key] as unknown as T | undefined) ?? env.get<T>(key) };
  }

  /** Sync read of the last loaded values (the gateway hot path never awaits a query). */
  get current(): CamoSettings {
    return { ...CAMO_DEFAULTS, ...this.cache.values };
  }

  async set(key: keyof CamoSettings, value: unknown, adminId: string): Promise<void> {
    if (!(key in CAMO_DEFAULTS)) throw new Error(`unknown camo setting ${String(key)}`);
    await this.prisma.camoSetting.upsert({
      where: { key },
      update: { value: value as never, updatedBy: adminId },
      create: { key, value: value as never, updatedBy: adminId },
    });
    await this.load(true);
  }
}
