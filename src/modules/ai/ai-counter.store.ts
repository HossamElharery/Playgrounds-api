import { Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { dayDate, utcDayString } from './ai-day';

const FLUSH_MS = 15_000;
const LOAD_RETRY_MS = 30_000;

interface Entry {
  /** Today's total as this instance knows it (what was in the table at load, plus what was added here). */
  count: number;
  /** Added here and not yet written. */
  pending: number;
  loaded: boolean;
  retryAt: number;
}

/**
 * Small named counters per UTC day, written behind: increments land in memory
 * at once and reach the table in batches (added to whatever other instances
 * wrote — `count = count + delta`, never overwritten). Without a database it
 * is a plain in-memory counter, which is how the tests and the eval script use it.
 */
@Injectable()
export class AiCounterStore implements OnModuleDestroy {
  private readonly logger = new Logger(AiCounterStore.name);
  private readonly entries = new Map<string, Entry>();
  private readonly timer: NodeJS.Timeout;
  private flushing: Promise<void> | null = null;
  private lastWarn = 0;

  constructor(@Optional() private readonly prisma?: PrismaService) {
    this.timer = setInterval(() => void this.flush(), FLUSH_MS);
    this.timer.unref?.();
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.timer);
    await this.flush();
  }

  private id(day: string, scope: string, key: string): string {
    return `${day}\u0000${scope}\u0000${key}`;
  }

  /** Makes sure today's stored value is known before it is compared with a limit. A read failure counts as zero: the database being down must never lock people out. */
  async ensure(scope: string, key: string, now = Date.now()): Promise<void> {
    const day = utcDayString(now);
    const id = this.id(day, scope, key);
    let e = this.entries.get(id);
    if (!e) {
      e = { count: 0, pending: 0, loaded: !this.prisma, retryAt: 0 };
      this.entries.set(id, e);
    }
    if (e.loaded || now < e.retryAt || !this.prisma) return;
    try {
      const row = await this.prisma.aiCounterDaily.findUnique({
        where: { day_scope_key: { day: dayDate(day), scope, key } },
        select: { count: true },
      });
      e.count += row?.count ?? 0;
      e.loaded = true;
    } catch (err) {
      e.retryAt = now + LOAD_RETRY_MS;
      this.warn(`counter read failed: ${String(err)}`);
    }
  }

  /** Today's count, synchronously (call `ensure` first when the stored value matters). */
  get(scope: string, key: string, now = Date.now()): number {
    return this.entries.get(this.id(utcDayString(now), scope, key))?.count ?? 0;
  }

  add(scope: string, key: string, n = 1, now = Date.now()): void {
    const day = utcDayString(now);
    const id = this.id(day, scope, key);
    let e = this.entries.get(id);
    if (!e) {
      e = { count: 0, pending: 0, loaded: !this.prisma, retryAt: 0 };
      this.entries.set(id, e);
    }
    e.count += n;
    e.pending += n;
  }

  /** Writes every pending increment. Safe to call at any time; concurrent calls share one write. */
  flush(): Promise<void> {
    if (!this.prisma) return Promise.resolve();
    if (this.flushing) return this.flushing;
    this.flushing = this.doFlush().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async doFlush(): Promise<void> {
    const batch: { id: string; day: string; scope: string; key: string; delta: number }[] = [];
    for (const [id, e] of this.entries) {
      if (e.pending > 0) {
        const [day, scope, key] = id.split('\u0000');
        batch.push({ id, day, scope, key, delta: e.pending });
      }
    }
    this.sweep();
    if (!batch.length || !this.prisma) return;
    try {
      const values = Prisma.join(
        batch.map((b) => Prisma.sql`(${dayDate(b.day)}::date, ${b.scope}, ${b.key}, ${b.delta}, NOW())`),
      );
      await this.prisma.$executeRaw`
        INSERT INTO "AiCounterDaily" ("day", "scope", "key", "count", "updatedAt")
        VALUES ${values}
        ON CONFLICT ("day", "scope", "key")
        DO UPDATE SET "count" = "AiCounterDaily"."count" + EXCLUDED."count", "updatedAt" = NOW()`;
      for (const b of batch) {
        const e = this.entries.get(b.id);
        if (e) e.pending = Math.max(0, e.pending - b.delta);
      }
    } catch (err) {
      this.warn(`counter flush failed (kept for the next try): ${String(err)}`);
    }
  }

  /** Yesterday's entries are written and dropped; the table keeps them. */
  private sweep(): void {
    const today = utcDayString();
    for (const [id, e] of this.entries) {
      if (!id.startsWith(today) && e.pending === 0) this.entries.delete(id);
    }
  }

  private warn(message: string): void {
    const now = Date.now();
    if (now - this.lastWarn > 60_000) {
      this.lastWarn = now;
      this.logger.warn(`[ai-counter] ${message}`);
    }
  }
}
