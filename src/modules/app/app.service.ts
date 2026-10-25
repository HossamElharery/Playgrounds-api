import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { isShutdownDraining } from '../../common/lifecycle/shutdown-state';

@Injectable()
export class AppService {
  constructor(private readonly prisma: PrismaService) {}

  async ready() {
    if (isShutdownDraining()) {
      return { status: 'draining', unfinishedMigrations: 0, dbMs: 0 };
    }
    const started = Date.now();
    await this.prisma.$queryRaw`SELECT 1`;
    const pending = await this.prisma.$queryRaw<
      { n: number }[]
    >`SELECT COUNT(*)::int AS n FROM "_prisma_migrations" WHERE finished_at IS NULL AND rolled_back_at IS NULL`;
    const unfinished = pending[0]?.n ?? 0;
    return {
      status: isShutdownDraining()
        ? 'draining'
        : unfinished === 0
          ? 'ready'
          : 'migrating',
      unfinishedMigrations: unfinished,
      dbMs: Date.now() - started,
    };
  }

  health() {
    return {
      status: isShutdownDraining() ? 'draining' : 'ok',
      service: 'matchena-api',
      time: new Date().toISOString(),
    };
  }
}
