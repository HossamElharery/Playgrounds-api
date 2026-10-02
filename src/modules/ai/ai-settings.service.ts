import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export type AiSettingKind = 'int' | 'usd' | 'bool';

export interface AiSettingDef {
  kind: AiSettingKind;
  /** The environment variable that meant the same thing before this was editable. */
  env?: string;
  /** null = derived by the caller when nothing is set. */
  def: number | boolean | null;
  min?: number;
  max?: number;
  group: 'captain' | 'owner' | 'budget' | 'protection';
}

/**
 * Every AI limit an admin may change. Each has a floor and a ceiling so a typo
 * cannot switch the assistant off for everyone by accident (0 is only allowed
 * where "off" is a meaningful answer), nor open the budget to an unbounded bill.
 */
export const AI_SETTING_DEFS = {
  captainGuestsEnabled: { kind: 'bool', def: true, group: 'captain' },
  captainGuestPerDay: { kind: 'int', env: 'CAPTAIN_GUEST_PER_DAY', def: 15, min: 0, max: 500, group: 'captain' },
  captainGuestPerMinute: { kind: 'int', env: 'CAPTAIN_GUEST_PER_MINUTE', def: 5, min: 1, max: 60, group: 'captain' },
  captainGuestIpPerDay: { kind: 'int', env: 'CAPTAIN_GUEST_IP_PER_DAY', def: null, min: 1, max: 5000, group: 'captain' },
  captainGuestIpPerMinute: { kind: 'int', env: 'CAPTAIN_GUEST_IP_PER_MINUTE', def: 10, min: 1, max: 120, group: 'captain' },
  captainUserPerDay: { kind: 'int', env: 'CAPTAIN_USER_PER_DAY', def: 150, min: 1, max: 2000, group: 'captain' },
  captainUserPerMinute: { kind: 'int', env: 'CAPTAIN_USER_PER_MINUTE', def: 10, min: 1, max: 60, group: 'captain' },
  ownerPerDay: { kind: 'int', def: 600, min: 20, max: 5000, group: 'owner' },
  ownerPerMinute: { kind: 'int', def: 20, min: 1, max: 120, group: 'owner' },
  ownerBudgetUsd: { kind: 'usd', env: 'AI_OWNER_DAILY_BUDGET_USD', def: 1.5, min: 0.05, max: 50, group: 'budget' },
  publicBudgetUsd: { kind: 'usd', env: 'AI_PUBLIC_DAILY_BUDGET_USD', def: 1.5, min: 0.05, max: 50, group: 'budget' },
  turnstileAfterMessages: { kind: 'int', def: 5, min: 1, max: 50, group: 'protection' },
  questionRetentionDays: { kind: 'int', def: 45, min: 30, max: 60, group: 'protection' },
} as const satisfies Record<string, AiSettingDef>;

export type AiSettingKey = keyof typeof AI_SETTING_DEFS;
export const AI_SETTING_KEYS = Object.keys(AI_SETTING_DEFS) as AiSettingKey[];

export interface AiSettingView {
  key: AiSettingKey;
  value: number | boolean | null;
  source: 'override' | 'env' | 'default';
  default: number | boolean | null;
  env: string | null;
  kind: AiSettingKind;
  min: number | null;
  max: number | null;
  group: AiSettingDef['group'];
}

const REFRESH_MS = 30_000;

/** Why a submitted value was refused, per key. Empty = fine. */
export function validateSettingsPatch(patch: Record<string, unknown>): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const [key, raw] of Object.entries(patch)) {
    const def = (AI_SETTING_DEFS as Record<string, AiSettingDef>)[key];
    if (!def) {
      errors[key] = 'unknown setting';
      continue;
    }
    if (raw === null) continue; // null = go back to the environment / default
    if (def.kind === 'bool') {
      if (typeof raw !== 'boolean') errors[key] = 'must be true or false';
      continue;
    }
    const n = typeof raw === 'number' ? raw : Number.NaN;
    if (!Number.isFinite(n)) {
      errors[key] = 'must be a number';
    } else if (def.kind === 'int' && !Number.isInteger(n)) {
      errors[key] = 'must be a whole number';
    } else if (def.min !== undefined && n < def.min) {
      errors[key] = `must be at least ${def.min}`;
    } else if (def.max !== undefined && n > def.max) {
      errors[key] = `must be at most ${def.max}`;
    }
  }
  return errors;
}

/**
 * Admin-set values win over the environment variable of the same meaning,
 * which wins over the built-in default. Reads are synchronous from a cache
 * that is refreshed in the background: a hot path never waits on the database,
 * and a database hiccup keeps the last known values.
 */
@Injectable()
export class AiSettingsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AiSettingsService.name);
  private overrides = new Map<string, number | boolean>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: ConfigService,
    @Optional() private readonly prisma?: PrismaService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => void this.refresh(), REFRESH_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async refresh(): Promise<void> {
    if (!this.prisma) return;
    try {
      const rows = await this.prisma.aiSetting.findMany();
      const next = new Map<string, number | boolean>();
      for (const r of rows) {
        const def = (AI_SETTING_DEFS as Record<string, AiSettingDef>)[r.key];
        if (!def) continue;
        const v = r.value;
        if (def.kind === 'bool' ? typeof v === 'boolean' : typeof v === 'number' && Number.isFinite(v)) {
          next.set(r.key, v as number | boolean);
        }
      }
      this.overrides = next;
    } catch (err) {
      this.logger.warn(`[ai-settings] refresh failed, keeping the last values: ${String(err)}`);
    }
  }

  private fromEnv(def: AiSettingDef): number | null {
    if (!def.env) return null;
    const raw = (this.config.get<string>(def.env) ?? '').trim();
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  /** The number in force. `null` only for a setting whose default is derived by the caller. */
  number(key: AiSettingKey): number | null {
    const def: AiSettingDef = AI_SETTING_DEFS[key];
    const o = this.overrides.get(key);
    if (typeof o === 'number') return o;
    return this.fromEnv(def) ?? (typeof def.def === 'number' ? def.def : null);
  }

  flag(key: AiSettingKey): boolean {
    const def: AiSettingDef = AI_SETTING_DEFS[key];
    const o = this.overrides.get(key);
    if (typeof o === 'boolean') return o;
    return typeof def.def === 'boolean' ? def.def : false;
  }

  describe(): AiSettingView[] {
    return AI_SETTING_KEYS.map((key) => {
      const def: AiSettingDef = AI_SETTING_DEFS[key];
      const overridden = this.overrides.has(key);
      const envValue = this.fromEnv(def);
      return {
        key,
        value: def.kind === 'bool' ? this.flag(key) : this.number(key),
        source: overridden ? 'override' : envValue !== null ? 'env' : 'default',
        default: def.def,
        env: def.env ?? null,
        kind: def.kind,
        min: def.min ?? null,
        max: def.max ?? null,
        group: def.group,
      };
    });
  }

  /** Saves the given values (null removes an override). Throws nothing: the caller validates first with `validateSettingsPatch`. */
  async update(patch: Record<string, number | boolean | null>, actorUserId: string): Promise<void> {
    if (!this.prisma) throw new Error('settings need a database');
    const prisma = this.prisma;
    await prisma.$transaction(
      Object.entries(patch).map(([key, value]) =>
        value === null
          ? prisma.aiSetting.deleteMany({ where: { key } })
          : prisma.aiSetting.upsert({
              where: { key },
              create: { key, value: value as Prisma.InputJsonValue, updatedById: actorUserId },
              update: { value: value as Prisma.InputJsonValue, updatedById: actorUserId },
            }),
      ),
    );
    await this.refresh();
  }
}
