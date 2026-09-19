import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { Cron, CronExpression } from '@nestjs/schedule';

@Injectable()
export class IndexNowService {
  private readonly logger = new Logger(IndexNowService.name);
  private lastResult: { at: string; status: number; urls: string[] } | null = null;
  private changedSince = new Date();
  private sweepInFlight = false;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async notifyVenueById(venueId: string): Promise<void> {
    const venue = await this.prisma.venue.findUnique({
      where: { id: venueId },
      select: { slug: true },
    });
    if (!venue) return;
    await this.notifyUrls([`/ar/venues/${venue.slug}`, `/en/venues/${venue.slug}`]);
  }

  async notifyUrls(paths: string[]): Promise<void> {
    const key = this.config.get<string>('INDEXNOW_KEY')?.trim();
    const siteUrl = this.config.get<string>('SITE_URL')?.trim()?.replace(/\/$/, '');
    if (!key || !siteUrl || !paths.length) return;
    const endpoint = this.config.get<string>('INDEXNOW_ENDPOINT') || 'https://api.indexnow.org/indexnow';
    const urls = [...new Set(paths.map((path) => new URL(path, siteUrl).toString()))];
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          host: new URL(siteUrl).host,
          key,
          keyLocation: `${siteUrl}/${key}.txt`,
          urlList: urls,
        }),
      });
      this.lastResult = { at: new Date().toISOString(), status: response.status, urls };
      if (!response.ok && response.status !== 202) {
        this.logger.warn(`IndexNow returned ${response.status} for ${urls.length} URL(s)`);
      }
    } catch (error) {
      this.logger.warn(`IndexNow request failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  /**
   * Safety net for mutation paths outside VenuesService (partner approval and
   * admin management). Must not poll every second: that is one Venue query
   * per second in production even when IndexNow is unset, and a log flood
   * whenever Postgres blips.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async notifyRecentlyChangedVenues(): Promise<void> {
    if (this.sweepInFlight || !this.configured()) return;
    this.sweepInFlight = true;
    const until = new Date();
    try {
      const changed = await this.prisma.venue.findMany({
        where: { updatedAt: { gt: this.changedSince, lte: until } },
        select: { slug: true },
        take: 1000,
      });
      this.changedSince = until;
      if (!changed.length) return;
      await this.notifyUrls(changed.flatMap((venue) => [
        `/ar/venues/${venue.slug}`,
        `/en/venues/${venue.slug}`,
      ]));
    } catch (error) {
      this.logger.warn(
        `IndexNow venue sweep skipped: ${error instanceof Error ? error.message : error}`,
      );
    } finally {
      this.sweepInFlight = false;
    }
  }

  status() {
    return {
      configured: this.configured(),
      lastResult: this.lastResult,
    };
  }

  private configured(): boolean {
    return Boolean(
      this.config.get<string>('INDEXNOW_KEY')?.trim() &&
        this.config.get<string>('SITE_URL')?.trim(),
    );
  }
}
