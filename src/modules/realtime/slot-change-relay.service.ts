import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { withJobLock } from '../../common/utils/job-lock.util';
import { RealtimeGatewayEmitter } from './realtime-emitter.interface';

/** The Socket.IO room of players looking at one venue's availability. */
export const slotsRoom = (venueId: string) => `venue-slots:${venueId}`;

export interface SlotChangeRow {
  id: bigint | number;
  venueId: string;
  courtId: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
  kind: string;
}

export interface RelayEvent {
  room: string;
  event: { type: string; [key: string]: unknown };
}

/**
 * Turns a burst of outbox rows into the fewest events: one `venue.visibility.changed`
 * per venue whose state changed, and one `booking.slots.changed` per court (or
 * venue-wide block) with the time range that moved. Pure, so it is easy to test.
 */
export function coalesceSlotChanges(rows: SlotChangeRow[]): RelayEvent[] {
  const events: RelayEvent[] = [];
  const venueChanged = new Set<string>();
  const ranges = new Map<string, { venueId: string; courtId: string | null; from: number; to: number }>();
  for (const row of rows) {
    if (row.kind === 'venue') {
      venueChanged.add(row.venueId);
      continue;
    }
    const key = `${row.venueId}|${row.courtId ?? '*'}`;
    const from = row.startsAt ? row.startsAt.getTime() : 0;
    const to = row.endsAt ? row.endsAt.getTime() : Number.MAX_SAFE_INTEGER;
    const hit = ranges.get(key);
    if (hit) {
      hit.from = Math.min(hit.from, from);
      hit.to = Math.max(hit.to, to);
    } else {
      ranges.set(key, { venueId: row.venueId, courtId: row.courtId, from, to });
    }
  }
  for (const venueId of venueChanged) {
    events.push({ room: slotsRoom(venueId), event: { type: 'venue.visibility.changed', venueId } });
  }
  for (const r of ranges.values()) {
    events.push({
      room: slotsRoom(r.venueId),
      event: {
        type: 'booking.slots.changed',
        venueId: r.venueId,
        courtId: r.courtId,
        from: new Date(r.from).toISOString(),
        to: new Date(Math.min(r.to, 8.64e15)).toISOString(),
      },
    });
  }
  return events;
}

const POLL_MS = 1000;
const BATCH = 500;
const CLEANUP_EVERY_TICKS = 60;
const KEEP_MINUTES = 10;

/**
 * Pushes availability changes to the players watching a venue, within about a second,
 * whoever made the change (another player, the owner, an admin, the expiry job).
 * Every backend instance runs its own relay and serves its own sockets, so this also
 * works with several instances and no Redis adapter.
 */
@Injectable()
export class SlotChangeRelay implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SlotChangeRelay.name);
  private cursor: bigint | null = null;
  private timer: NodeJS.Timeout | null = null;
  private ticks = 0;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly emitter: RealtimeGatewayEmitter,
  ) {}

  onModuleInit(): void {
    if (process.env['SLOT_RELAY'] === 'off') return;
    this.timer = setInterval(() => void this.tick(), POLL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One poll. Public so tests can drive it without waiting for the timer. */
  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      if (this.cursor === null) {
        const [{ max }] = await this.prisma.$queryRaw<{ max: bigint | null }[]>`SELECT MAX("id") AS max FROM "SlotChange"`;
        this.cursor = max ?? 0n; // only changes from now on; older ones were someone else's news
        return 0;
      }
      const rows = await this.prisma.$queryRaw<SlotChangeRow[]>`
        SELECT "id", "venueId", "courtId", "startsAt", "endsAt", "kind"
        FROM "SlotChange" WHERE "id" > ${this.cursor} ORDER BY "id" LIMIT ${BATCH}`;
      if (rows.length) {
        this.cursor = BigInt(rows[rows.length - 1].id);
        for (const { room, event } of coalesceSlotChanges(rows)) this.emitter.emitToRoom(room, event);
      }
      if (++this.ticks % CLEANUP_EVERY_TICKS === 0) await this.cleanup();
      return rows.length;
    } catch (error) {
      this.logger.warn(`slot relay tick failed: ${error instanceof Error ? error.message : error}`);
      return 0;
    } finally {
      this.running = false;
    }
  }

  private async cleanup(): Promise<void> {
    await withJobLock(this.prisma, 'slotChangeCleanup', async () => {
      await this.prisma.$executeRaw`
        DELETE FROM "SlotChange" WHERE "createdAt" < NOW() - (${KEEP_MINUTES} * INTERVAL '1 minute')`;
    });
  }
}
