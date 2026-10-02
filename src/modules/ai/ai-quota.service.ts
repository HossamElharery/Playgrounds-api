import { Injectable, OnModuleDestroy, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiCounterStore } from './ai-counter.store';
import { identityRef, identitySalt, storedQuotaKey } from './ai-redact';

export interface QuotaRule {
  /** Who is counted: `ip:1.2.3.4`, `dev:abc`, `user:42`. */
  key: string;
  perMinute: number;
  perDay: number;
}

export type QuotaVerdict =
  | { ok: true }
  | { ok: false; reason: 'minute' | 'day'; retryAfterSec: number; key: string };

interface MinuteCounter {
  start: number;
  count: number;
}

/**
 * How many AI messages one identity may send. A message is only counted when
 * every rule passes, so a visitor sharing a busy network is not charged for a
 * request that was refused anyway.
 *
 * The day's count lives in the database (batched, hashed for addresses and
 * devices), so a deploy no longer hands everyone a fresh allowance and every
 * instance counts against the same total. The per-minute window stays in
 * memory: it only matters for the next sixty seconds and has no value on disk.
 */
@Injectable()
export class AiQuotaService implements OnModuleDestroy {
  private readonly minutes = new Map<string, MinuteCounter>();
  private readonly sweeper = setInterval(() => this.sweep(), 5 * 60_000);
  private readonly counters: AiCounterStore;
  private readonly salt: string;

  constructor(
    @Optional() counters?: AiCounterStore,
    @Optional() config?: ConfigService,
  ) {
    this.counters = counters ?? new AiCounterStore();
    this.salt = identitySalt(config);
    this.sweeper.unref?.();
  }

  onModuleDestroy(): void {
    clearInterval(this.sweeper);
  }

  /** A short hash of a quota key, for logs and screens that must not show who someone is. */
  ref(key: string): string {
    return identityRef(this.salt, key);
  }

  /** Counts one message against every rule, or refuses without counting. */
  async take(scope: string, rules: QuotaRule[], now = Date.now()): Promise<QuotaVerdict> {
    const dayScope = `quota:${scope}`;
    const keyed = rules.map((rule) => ({ rule, stored: storedQuotaKey(this.salt, rule.key) }));
    // Load today's stored counts first; everything after this is synchronous, so two requests cannot interleave between the check and the count.
    await Promise.all(keyed.map((k) => this.counters.ensure(dayScope, k.stored, now)));

    const prepared = keyed.map(({ rule, stored }) => {
      const id = `${scope}|${rule.key}`;
      let m = this.minutes.get(id);
      if (!m || now - m.start >= 60_000) {
        m = { start: now, count: 0 };
        this.minutes.set(id, m);
      }
      return { rule, stored, m };
    });
    for (const { rule, stored, m } of prepared) {
      if (m.count >= rule.perMinute) {
        return {
          ok: false,
          reason: 'minute',
          retryAfterSec: Math.max(1, Math.ceil((m.start + 60_000 - now) / 1000)),
          key: rule.key,
        };
      }
      if (this.counters.get(dayScope, stored, now) >= rule.perDay) {
        return { ok: false, reason: 'day', retryAfterSec: secondsToMidnightUtc(now), key: rule.key };
      }
    }
    for (const { stored, m } of prepared) {
      m.count += 1;
      this.counters.add(dayScope, stored, 1, now);
    }
    return { ok: true };
  }

  /** How many messages this identity has sent today (for a "suspicious guest" check). */
  async sentToday(scope: string, key: string, now = Date.now()): Promise<number> {
    const stored = storedQuotaKey(this.salt, key);
    await this.counters.ensure(`quota:${scope}`, stored, now);
    return this.counters.get(`quota:${scope}`, stored, now);
  }

  private sweep(): void {
    const cutoff = Date.now() - 2 * 60_000;
    for (const [id, m] of this.minutes) if (m.start < cutoff) this.minutes.delete(id);
  }
}

function secondsToMidnightUtc(now: number): number {
  const d = new Date(now);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now) / 1000));
}
