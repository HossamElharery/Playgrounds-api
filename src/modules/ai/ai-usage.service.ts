import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AiCounterStore } from './ai-counter.store';
import { AiSettingsService } from './ai-settings.service';
import { dayDate, fromMicros, toMicros, utcDayString } from './ai-day';
import { AiUnavailableError, type AiProfile } from './ai-provider.types';

interface Row {
  calls: number;
  failures: number;
  fallbackCalls: number;
  costMicros: number;
  totalMs: number;
}

export interface AiCallRecord {
  profile: AiProfile;
  provider: string;
  model: string;
  ok: boolean;
  ms: number;
  costUsd: number;
  status?: number;
  routeIndex?: number;
}

const FLUSH_MS = 15_000;
const EMPTY = (): Row => ({ calls: 0, failures: 0, fallbackCalls: 0, costMicros: 0, totalMs: 0 });

const rowKey = (day: string, profile: string, provider: string, model: string) =>
  `${day}\u0000${profile}\u0000${provider}\u0000${model}`;

@Injectable()
export class AiUsageService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AiUsageService.name);
  private readonly pending = new Map<string, Row>();
  private stored = new Map<string, Row>();
  private readonly localStats = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;
  private warned = false;
  private warnedDay = utcDayString();

  constructor(
    private readonly config: ConfigService,
    @Optional() private readonly prisma?: PrismaService,
    @Optional() private readonly settings?: AiSettingsService,
    @Optional() private readonly counters?: AiCounterStore,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => void this.flush(), FLUSH_MS);
    this.timer.unref?.();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.flush();
  }


  budgetUsd(profile: AiProfile): number {
    const key = profile === 'owner' ? 'ownerBudgetUsd' : 'publicBudgetUsd';
    if (this.settings) return this.settings.number(key) ?? 1.5;
    const env = profile === 'owner' ? 'AI_OWNER_DAILY_BUDGET_USD' : 'AI_PUBLIC_DAILY_BUDGET_USD';
    const n = Number(this.config.get<string>(env));
    return Number.isFinite(n) && n > 0 ? n : 1.5;
  }

  private sumMicros(profile: AiProfile, day: string): number {
    let total = 0;
    for (const map of [this.stored, this.pending]) {
      for (const [k, row] of map) {
        const [d, p] = k.split('\u0000');
        if (d === day && p === profile) total += row.costMicros;
      }
    }
    return total;
  }

  spentToday(profile: AiProfile): number {
    return fromMicros(this.sumMicros(profile, utcDayString()));
  }

  assertBudget(profile: AiProfile): void {
    const day = utcDayString();
    if (day !== this.warnedDay) {
      this.warnedDay = day;
      this.warned = false;
    }
    const spent = this.spentToday(profile);
    const limit = this.budgetUsd(profile);
    if (spent >= limit) {
      this.bump(`block:budget:${profile}`);
      throw new AiUnavailableError('AI_BUDGET', 'budget');
    }
    if (!this.warned && spent >= limit * 0.7) {
      this.warned = true;
      this.logger.warn(`[ai-usage] ${profile} has used ${spent.toFixed(3)} of its ${limit} USD daily budget`);
    }
  }

  publicUnderPressure(): boolean {
    return this.spentToday('public') >= this.budgetUsd('public') * 0.7;
  }


  record(call: AiCallRecord): void {
    const key = rowKey(utcDayString(), call.profile, call.provider, call.model);
    const row = this.pending.get(key) ?? EMPTY();
    row.calls += 1;
    if (!call.ok) row.failures += 1;
    if (call.ok && (call.routeIndex ?? 0) > 0) row.fallbackCalls += 1;
    row.costMicros += toMicros(call.costUsd);
    row.totalMs += Math.max(0, Math.round(call.ms));
    this.pending.set(key, row);
    this.logger.log(
      `[ai] profile=${call.profile} provider=${call.provider} model=${call.model} ok=${call.ok} ms=${call.ms} cost=${call.costUsd.toFixed(6)}${call.status ? ` status=${call.status}` : ''}${call.routeIndex ? ` route=${call.routeIndex}` : ''}`,
    );
  }

  bump(name: string, n = 1): void {
    if (this.counters) this.counters.add('stat', name, n);
    else this.localStats.set(name, (this.localStats.get(name) ?? 0) + n);
  }

  statToday(name: string): number {
    return this.counters ? this.counters.get('stat', name) : (this.localStats.get(name) ?? 0);
  }


  flush(): Promise<void> {
    if (!this.prisma) return Promise.resolve();
    if (this.flushing) return this.flushing;
    this.flushing = this.doFlush().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async doFlush(): Promise<void> {
    const prisma = this.prisma;
    if (!prisma) return;
    const batch = [...this.pending.entries()].map(([k, row]) => ({ k, row: { ...row } }));
    if (batch.length) {
      try {
        const values = Prisma.join(
          batch.map(({ k, row }) => {
            const [day, profile, provider, model] = k.split('\u0000');
            return Prisma.sql`(${dayDate(day)}::date, ${profile}, ${provider}, ${model}, ${row.calls}, ${row.failures}, ${row.fallbackCalls}, ${row.costMicros}, ${row.totalMs}, NOW())`;
          }),
        );
        await prisma.$executeRaw`
          INSERT INTO "AiCallDaily" ("day", "profile", "provider", "model", "calls", "failures", "fallbackCalls", "costMicros", "totalMs", "updatedAt")
          VALUES ${values}
          ON CONFLICT ("day", "profile", "provider", "model")
          DO UPDATE SET
            "calls" = "AiCallDaily"."calls" + EXCLUDED."calls",
            "failures" = "AiCallDaily"."failures" + EXCLUDED."failures",
            "fallbackCalls" = "AiCallDaily"."fallbackCalls" + EXCLUDED."fallbackCalls",
            "costMicros" = "AiCallDaily"."costMicros" + EXCLUDED."costMicros",
            "totalMs" = "AiCallDaily"."totalMs" + EXCLUDED."totalMs",
            "updatedAt" = NOW()`;
        for (const { k, row } of batch) {
          const p = this.pending.get(k);
          if (!p) continue;
          p.calls -= row.calls;
          p.failures -= row.failures;
          p.fallbackCalls -= row.fallbackCalls;
          p.costMicros -= row.costMicros;
          p.totalMs -= row.totalMs;
          if (p.calls <= 0 && p.costMicros <= 0 && p.failures <= 0) this.pending.delete(k);
        }
      } catch (err) {
        this.logger.warn(`[ai-usage] could not save usage (kept in memory, will retry): ${String(err)}`);
        return;
      }
    }
    await this.refresh();
  }

  async refresh(): Promise<void> {
    if (!this.prisma) return;
    const day = utcDayString();
    try {
      const rows = await this.prisma.aiCallDaily.findMany({ where: { day: dayDate(day) } });
      const next = new Map<string, Row>();
      for (const r of rows) {
        next.set(rowKey(day, r.profile, r.provider, r.model), {
          calls: r.calls,
          failures: r.failures,
          fallbackCalls: r.fallbackCalls,
          costMicros: r.costMicros,
          totalMs: r.totalMs,
        });
      }
      this.stored = next;
    } catch (err) {
      this.logger.warn(`[ai-usage] could not read today's usage: ${String(err)}`);
    }
  }


  snapshot() {
    const day = utcDayString();
    const models = new Map<string, Row & { profile: AiProfile; provider: string; model: string }>();
    for (const map of [this.stored, this.pending]) {
      for (const [k, r] of map) {
        const [d, profile, provider, model] = k.split('\u0000');
        if (d !== day) continue;
        const key = `${profile}:${provider}:${model}`;
        const m = models.get(key) ?? { ...EMPTY(), profile: profile as AiProfile, provider, model };
        m.calls += r.calls;
        m.failures += r.failures;
        m.fallbackCalls += r.fallbackCalls;
        m.costMicros += r.costMicros;
        m.totalMs += r.totalMs;
        models.set(key, m);
      }
    }
    const sum = (profile: AiProfile) => {
      const own = [...models.values()].filter((m) => m.profile === profile);
      return {
        calls: own.reduce((n, m) => n + m.calls, 0),
        failures: own.reduce((n, m) => n + m.failures, 0),
        fallbackCalls: own.reduce((n, m) => n + m.fallbackCalls, 0),
        spendUsd: fromMicros(own.reduce((n, m) => n + m.costMicros, 0)),
        budgetUsd: this.budgetUsd(profile),
      };
    };
    return {
      day,
      profiles: { owner: sum('owner'), public: sum('public') },
      models: [...models.entries()].map(([key, m]) => ({
        key,
        profile: m.profile,
        provider: m.provider,
        model: m.model,
        calls: m.calls,
        failures: m.failures,
        fallbackCalls: m.fallbackCalls,
        spendUsd: Number(fromMicros(m.costMicros).toFixed(6)),
        avgMs: m.calls ? Math.round(m.totalMs / m.calls) : 0,
      })),
    };
  }
}
