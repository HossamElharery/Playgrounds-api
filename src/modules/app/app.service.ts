import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AppService {
  constructor(private readonly prisma: PrismaService) {}

  async ready() {
    const started = Date.now();
    await this.prisma.$queryRaw`SELECT 1`;
    const pending = await this.prisma.$queryRaw<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM "_prisma_migrations" WHERE finished_at IS NULL AND rolled_back_at IS NULL`;
    const unfinished = pending[0]?.n ?? 0;
    return { status: unfinished === 0 ? 'ready' : 'migrating', unfinishedMigrations: unfinished, dbMs: Date.now() - started };
  }

  health() {
    return {
      status: 'ok',
      service: 'matchena-api',
      time: new Date().toISOString(),
    };
  }
}
