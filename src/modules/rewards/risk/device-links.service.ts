import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';

const ID_SHAPE = /^[A-Za-z0-9_-]{16,80}$/;
const RECORD_EVERY_MS = 6 * 3_600_000;
const MAX_REMEMBERED = 5000;

export function hashDeviceId(raw: string): string | null {
  if (!ID_SHAPE.test(raw)) return null;
  return createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

/**
 * Which accounts belong to the same person. Two accounts are linked when they
 * were used from the same install (x-device-id header) or share a push device
 * token. It is a signal against casual multi-accounting, not proof: rewards
 * never rely on it alone.
 */
@Injectable()
export class DeviceLinksService {
  private readonly recent = new Map<string, number>();

  constructor(private readonly prisma: PrismaService) {}

  /** Remembers that this account was used from this device. Cheap: at most once per 6h per pair. */
  async record(userId: string, rawDeviceId: string | undefined): Promise<void> {
    if (!rawDeviceId) return;
    const deviceHash = hashDeviceId(rawDeviceId);
    if (!deviceHash) return;
    const key = `${userId}:${deviceHash}`;
    const now = Date.now();
    const last = this.recent.get(key);
    if (last && now - last < RECORD_EVERY_MS) return;
    if (this.recent.size >= MAX_REMEMBERED) this.recent.clear();
    this.recent.set(key, now);
    await this.prisma.userDevice.upsert({
      where: { userId_deviceHash: { userId, deviceHash } },
      create: { userId, deviceHash },
      update: { lastSeenAt: new Date() },
    });
  }

  /** Every other account that shares a device or a push token with this one. */
  async linkedIds(userId: string): Promise<Set<string>> {
    const [devices, tokens] = await Promise.all([
      this.prisma.userDevice.findMany({ where: { userId }, select: { deviceHash: true } }),
      this.prisma.deviceToken.findMany({ where: { userId }, select: { token: true } }),
    ]);
    const [byDevice, byToken] = await Promise.all([
      devices.length
        ? this.prisma.userDevice.findMany({
            where: { deviceHash: { in: devices.map((d) => d.deviceHash) }, userId: { not: userId } },
            select: { userId: true },
          })
        : Promise.resolve([]),
      tokens.length
        ? this.prisma.deviceToken.findMany({
            where: { token: { in: tokens.map((t) => t.token) }, userId: { not: userId } },
            select: { userId: true },
          })
        : Promise.resolve([]),
    ]);
    return new Set([...byDevice, ...byToken].map((r) => r.userId));
  }

  async areLinked(a: string, b: string): Promise<boolean> {
    if (a === b) return true;
    return (await this.linkedIds(a)).has(b);
  }
}
