import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AiCounterStore } from '../ai-counter.store';
import { AiProviderService } from '../ai-provider.service';
import { AiUsageService } from '../ai-usage.service';
import { AiSettingsService, validateSettingsPatch, type AiSettingKey } from '../ai-settings.service';
import { TurnstileService } from '../turnstile.service';
import { addDays, dayDate, fromMicros, utcDayString } from '../ai-day';
import type { AiProfile } from '../ai-provider.types';

interface Agg {
  calls: number;
  failures: number;
  fallbackCalls: number;
  costMicros: number;
  totalMs: number;
}
const zero = (): Agg => ({ calls: 0, failures: 0, fallbackCalls: 0, costMicros: 0, totalMs: 0 });
const add = (a: Agg, r: Agg) => {
  a.calls += r.calls;
  a.failures += r.failures;
  a.fallbackCalls += r.fallbackCalls;
  a.costMicros += r.costMicros;
  a.totalMs += r.totalMs;
};
const view = (a: Agg) => ({
  calls: a.calls,
  failures: a.failures,
  fallbackCalls: a.fallbackCalls,
  spendUsd: Number(fromMicros(a.costMicros).toFixed(4)),
  avgMs: a.calls ? Math.round(a.totalMs / a.calls) : 0,
  failureRate: a.calls ? Number((a.failures / a.calls).toFixed(3)) : 0,
});

export interface CreditInfo {
  checkedAt: string;
  /** Prepaid balance of the OpenRouter account: bought minus used. */
  accountRemainingUsd: number | null;
  /** What the key's own monthly limit still allows. */
  keyRemainingUsd: number | null;
  keyLimitUsd: number | null;
  error: string | null;
}

export type AiAlert = {
  level: 'danger' | 'warn';
  code: 'ai_disabled' | 'out_of_credit' | 'auth_failed' | 'low_credit' | 'budget_exhausted' | 'budget_high' | 'keyword_fallback_high' | 'route_fallback_high' | 'owner_unavailable';
  profile?: AiProfile;
  value?: number;
  model?: string;
};

const CREDIT_TTL_MS = 60_000;
const LOW_CREDIT_USD = 2;

/** The numbers behind the admin's AI overview and its limits screen. */
@Injectable()
export class AiAdminOverviewService {
  private readonly logger = new Logger(AiAdminOverviewService.name);
  private credit: { exp: number; value: CreditInfo } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly provider: AiProviderService,
    private readonly usage: AiUsageService,
    private readonly counters: AiCounterStore,
    private readonly settings: AiSettingsService,
    private readonly turnstile: TurnstileService,
  ) {}

  /** Everything this instance still holds in memory is written first, so the screen is current to the second. */
  private async settle(): Promise<void> {
    await Promise.all([this.usage.flush(), this.counters.flush()]);
  }

  private async statsSince(day: string): Promise<{ day: string; key: string; count: number }[]> {
    const rows = await this.prisma.aiCounterDaily.findMany({ where: { scope: 'stat', day: { gte: dayDate(day) } } });
    return rows.map((r) => ({ day: r.day.toISOString().slice(0, 10), key: r.key, count: r.count }));
  }

  // ------------------------------------------------------------ overview ----

  async overview() {
    await this.settle();
    const today = utcDayString();
    const weekStart = addDays(today, -6);
    const rows = await this.prisma.aiCallDaily.findMany({ where: { day: { gte: dayDate(addDays(today, -29)) } } });

    type Period = 'today' | 'week' | 'month';
    const inPeriod = (day: string, p: Period) => (p === 'today' ? day === today : p === 'week' ? day >= weekStart : true);
    const periods = (['today', 'week', 'month'] as Period[]).map((p) => p);
    const totals: Record<Period, Record<AiProfile, Agg>> = {
      today: { owner: zero(), public: zero() },
      week: { owner: zero(), public: zero() },
      month: { owner: zero(), public: zero() },
    };
    const models: Record<Period, Map<string, Agg & { profile: string; provider: string; model: string }>> = {
      today: new Map(),
      week: new Map(),
      month: new Map(),
    };
    const byDay = new Map<string, Record<AiProfile, Agg>>();
    for (const r of rows) {
      const day = r.day.toISOString().slice(0, 10);
      const profile = r.profile as AiProfile;
      const agg: Agg = { calls: r.calls, failures: r.failures, fallbackCalls: r.fallbackCalls, costMicros: r.costMicros, totalMs: r.totalMs };
      const d = byDay.get(day) ?? { owner: zero(), public: zero() };
      add(d[profile] ?? (d[profile] = zero()), agg);
      byDay.set(day, d);
      for (const p of periods) {
        if (!inPeriod(day, p)) continue;
        add(totals[p][profile] ?? (totals[p][profile] = zero()), agg);
        const key = `${r.profile}|${r.provider}|${r.model}`;
        const m = models[p].get(key) ?? { ...zero(), profile: r.profile, provider: r.provider, model: r.model };
        add(m, agg);
        models[p].set(key, m);
      }
    }

    const trend = Array.from({ length: 14 }, (_, i) => {
      const day = addDays(today, i - 13);
      const d = byDay.get(day);
      return {
        day,
        ownerUsd: Number(fromMicros(d?.owner.costMicros ?? 0).toFixed(4)),
        publicUsd: Number(fromMicros(d?.public.costMicros ?? 0).toFixed(4)),
        ownerCalls: d?.owner.calls ?? 0,
        publicCalls: d?.public.calls ?? 0,
      };
    });

    const stats = await this.statsSince(weekStart);
    const stat = (name: string, day?: string) => stats.filter((s) => s.key === name && (!day || s.day === day)).reduce((n, s) => n + s.count, 0);

    const startOfToday = dayDate(today);
    const [questionGroups, keywordToday, ownerGroups] = await Promise.all([
      this.prisma.aiQuestionLog.groupBy({ by: ['outcome'], where: { createdAt: { gte: startOfToday } }, _count: { _all: true } }),
      this.prisma.aiQuestionLog.count({
        where: { createdAt: { gte: startOfToday }, model: null, outcome: { notIn: ['limited', 'blocked', 'unavailable'] } },
      }),
      this.prisma.aiOwnerEventLog.groupBy({ by: ['outcome'], where: { event: 'ask', createdAt: { gte: startOfToday } }, _count: { _all: true } }),
    ]);
    const questionsByOutcome = Object.fromEntries(questionGroups.map((g) => [g.outcome, g._count._all]));
    const askedToday = questionGroups.filter((g) => !['limited', 'blocked'].includes(g.outcome)).reduce((n, g) => n + g._count._all, 0);
    const ownerByOutcome = Object.fromEntries(ownerGroups.map((g) => [g.outcome, g._count._all]));
    const ownerAsksToday = ownerGroups.reduce((n, g) => n + g._count._all, 0);

    const budgets = { owner: this.usage.budgetUsd('owner'), public: this.usage.budgetUsd('public') };
    const breakers = this.provider.breakerStates().map((b) => ({
      model: b.model,
      provider: b.kind,
      reason: b.reason,
      retryInSec: Math.max(0, Math.ceil((b.openUntil - Date.now()) / 1000)),
    }));
    const credit = await this.openRouterCredit();
    const keywordRate = askedToday ? keywordToday / askedToday : 0;
    const ownerUnavailable = ownerByOutcome['unavailable'] ?? 0;

    const alerts: AiAlert[] = [];
    if (!this.provider.enabled) alerts.push({ level: 'danger', code: 'ai_disabled' });
    for (const b of breakers) {
      if (b.reason === 'credit') alerts.push({ level: 'danger', code: 'out_of_credit', model: b.model });
      if (b.reason === 'auth') alerts.push({ level: 'danger', code: 'auth_failed', model: b.model });
    }
    const lowest = [credit.accountRemainingUsd, credit.keyRemainingUsd].filter((v): v is number => v !== null);
    if (lowest.length && Math.min(...lowest) < LOW_CREDIT_USD) alerts.push({ level: 'warn', code: 'low_credit', value: Math.min(...lowest) });
    for (const profile of ['owner', 'public'] as AiProfile[]) {
      const spent = fromMicros(totals.today[profile].costMicros);
      if (spent >= budgets[profile]) alerts.push({ level: 'danger', code: 'budget_exhausted', profile });
      else if (spent >= budgets[profile] * 0.7) alerts.push({ level: 'warn', code: 'budget_high', profile, value: Math.round((spent / budgets[profile]) * 100) });
    }
    if (askedToday >= 10 && keywordRate > 0.2) alerts.push({ level: 'warn', code: 'keyword_fallback_high', value: Math.round(keywordRate * 100) });
    const publicCalls = totals.today.public.calls;
    if (publicCalls >= 10 && totals.today.public.fallbackCalls / publicCalls > 0.3) {
      alerts.push({ level: 'warn', code: 'route_fallback_high', value: Math.round((totals.today.public.fallbackCalls / publicCalls) * 100) });
    }
    if (ownerAsksToday >= 5 && ownerUnavailable / ownerAsksToday > 0.2) alerts.push({ level: 'warn', code: 'owner_unavailable', value: Math.round((ownerUnavailable / ownerAsksToday) * 100) });

    const modelList = (p: Period) => {
      const all = [...models[p].values()];
      const total = all.reduce((n, m) => n + m.calls, 0) || 1;
      return all
        .sort((a, b) => b.calls - a.calls)
        .map((m) => ({ profile: m.profile, provider: m.provider, model: m.model, ...view(m), share: Number((m.calls / total).toFixed(3)) }));
    };

    return {
      day: today,
      enabled: this.provider.enabled,
      budgets,
      spend: {
        owner: { today: view(totals.today.owner), week: view(totals.week.owner), month: view(totals.month.owner) },
        public: { today: view(totals.today.public), week: view(totals.week.public), month: view(totals.month.public) },
      },
      models: { today: modelList('today'), week: modelList('week'), month: modelList('month') },
      trend,
      chains: {
        owner: this.provider.chain('owner').map((s) => `${s.kind}:${s.model}`),
        public: this.provider.chain('public').map((s) => `${s.kind}:${s.model}`),
      },
      breakers,
      fallbacks: {
        askedToday,
        keywordToday,
        keywordRate: Number(keywordRate.toFixed(3)),
        routeFallbackToday: { owner: totals.today.owner.fallbackCalls, public: totals.today.public.fallbackCalls },
        keywordWeek: stat('keyword_fallback:public'),
        ownerAsksToday,
        ownerUnavailableToday: ownerUnavailable,
      },
      questions: { today: questionsByOutcome, ownerToday: ownerByOutcome },
      credit,
      alerts,
    };
  }

  /** What is left to spend at OpenRouter, asked of OpenRouter itself with the server's key (never from the browser). */
  async openRouterCredit(): Promise<CreditInfo> {
    if (this.credit && this.credit.exp > Date.now()) return this.credit.value;
    const key = this.config.get<string>('OPENROUTER_API_KEY') ?? '';
    const value: CreditInfo = { checkedAt: new Date().toISOString(), accountRemainingUsd: null, keyRemainingUsd: null, keyLimitUsd: null, error: null };
    if (!key) {
      value.error = 'no_key';
    } else {
      const get = async (path: string): Promise<Record<string, unknown> | null> => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5_000);
        try {
          const res = await fetch(`https://openrouter.ai/api/v1/${path}`, { headers: { Authorization: `Bearer ${key}` }, signal: controller.signal });
          if (!res.ok) return null;
          return ((await res.json()) as { data?: Record<string, unknown> }).data ?? null;
        } catch {
          return null;
        } finally {
          clearTimeout(timer);
        }
      };
      const [keyInfo, credits] = await Promise.all([get('key'), get('credits')]);
      const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
      if (keyInfo) {
        value.keyLimitUsd = num(keyInfo['limit']);
        value.keyRemainingUsd = num(keyInfo['limit_remaining']);
      }
      const bought = num(credits?.['total_credits']);
      const used = num(credits?.['total_usage']);
      if (bought !== null && used !== null) value.accountRemainingUsd = Number((bought - used).toFixed(4));
      if (!keyInfo && !credits) {
        value.error = 'unreachable';
        this.logger.warn('[ai-admin] could not read the OpenRouter balance');
      }
    }
    this.credit = { exp: Date.now() + CREDIT_TTL_MS, value };
    return value;
  }

  // -------------------------------------------------------------- limits ----

  async limits() {
    await this.settle();
    const today = utcDayString();
    const weekStart = addDays(today, -6);
    const stats = await this.statsSince(weekStart);
    const reasonOf = (key: string): { reason: string; kind: string } | null => {
      const [head, a, b] = key.split(':');
      if (head === 'limited' && (a === 'minute' || a === 'day' || a === 'guests_off')) return { reason: a, kind: b ?? 'guest' };
      if (head === 'blocked' && (a === 'spam' || a === 'noise' || a === 'empty')) return { reason: 'noise', kind: b ?? 'guest' };
      if (head === 'blocked' && a?.startsWith('challenge')) return { reason: 'challenge', kind: b ?? 'guest' };
      if (head === 'block' && a === 'budget') return { reason: 'budget', kind: b ?? 'public' };
      return null;
    };
    const blocksToday: Record<string, number> = {};
    const blocksByDay = new Map<string, Record<string, number>>();
    for (const s of stats) {
      const r = reasonOf(s.key);
      if (!r) continue;
      const d = blocksByDay.get(s.day) ?? {};
      d[r.reason] = (d[r.reason] ?? 0) + s.count;
      blocksByDay.set(s.day, d);
      if (s.day === today) blocksToday[r.reason] = (blocksToday[r.reason] ?? 0) + s.count;
    }

    const top = await this.prisma.aiCounterDaily.findMany({
      where: { day: dayDate(today), scope: { in: ['quota:captain', 'quota:owner'] } },
      orderBy: { count: 'desc' },
      take: 12,
    });
    const limitFor = (scope: string, kind: string): number | null => {
      if (scope === 'quota:owner') return this.settings.number('ownerPerDay');
      if (kind === 'ip') return this.settings.number('captainGuestIpPerDay') ?? (this.settings.number('captainGuestPerDay') ?? 15) * 4;
      if (kind === 'dev') return this.settings.number('captainGuestPerDay');
      return this.settings.number('captainUserPerDay');
    };
    const topAskers = top.map((r) => {
      const [kind, ...rest] = r.key.split(':');
      const id = rest.join(':');
      const limit = limitFor(r.scope, kind);
      return {
        audience: r.scope === 'quota:owner' ? 'owner' : kind === 'user' ? 'player' : 'guest',
        kind,
        // Addresses and devices are already one-way hashes; a user id is shortened too.
        label: `${kind}:${id.slice(0, 8)}…`,
        count: r.count,
        limit,
        atLimit: limit !== null && r.count >= limit,
      };
    });

    return {
      settings: this.settings.describe(),
      blocks: {
        today: blocksToday,
        days: Array.from({ length: 7 }, (_, i) => {
          const day = addDays(today, i - 6);
          return { day, ...(blocksByDay.get(day) ?? {}) };
        }),
      },
      topAskers,
      spend: {
        owner: { spentUsd: this.usage.spentToday('owner'), budgetUsd: this.usage.budgetUsd('owner') },
        public: { spentUsd: this.usage.spentToday('public'), budgetUsd: this.usage.budgetUsd('public') },
      },
      turnstile: { enabled: this.turnstile.enabled },
    };
  }

  /** Saves new limits (null = back to the environment/default). Every change is audited with before and after. */
  async updateLimits(patch: Record<string, unknown>, actorUserId: string) {
    const errors = validateSettingsPatch(patch);
    if (Object.keys(errors).length || !Object.keys(patch).length) {
      throw new BadRequestException({ message: 'VALIDATION_FAILED', code: 'VALIDATION_FAILED', result: { errors: Object.keys(errors).length ? errors : { patch: 'required' } } });
    }
    const before = Object.fromEntries(this.settings.describe().map((s) => [s.key, s.value]));
    await this.settings.update(patch as Record<AiSettingKey, number | boolean | null>, actorUserId);
    const after = Object.fromEntries(this.settings.describe().map((s) => [s.key, s.value]));
    const changed = Object.keys(patch).map((k) => ({ key: k, from: before[k] ?? null, to: after[k] ?? null }));
    await this.prisma.auditLogEntry.create({
      data: {
        actorUserId,
        action: 'ai.settings.update',
        targetType: 'ai_settings',
        targetId: 'limits',
        metadata: { changed } as Prisma.InputJsonValue,
      },
    });
    return this.limits();
  }
}
