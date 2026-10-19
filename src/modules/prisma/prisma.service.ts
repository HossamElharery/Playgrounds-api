import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor() {
    const configuredDatabaseUrl = process.env.DATABASE_URL;
    if (!configuredDatabaseUrl) {
      throw new Error('DATABASE_URL is required');
    }
    const databaseUrl = new URL(configuredDatabaseUrl);

    // A deployment starts several scheduled jobs together. Give the API a
    // bounded but sufficient pool so one background job cannot starve normal
    // requests or another scheduled job of a database connection.
    if (!databaseUrl.searchParams.has('connection_limit')) {
      databaseUrl.searchParams.set(
        'connection_limit',
        process.env.PRISMA_CONNECTION_LIMIT ?? '10',
      );
    }
    if (!databaseUrl.searchParams.has('pool_timeout')) {
      databaseUrl.searchParams.set(
        'pool_timeout',
        process.env.PRISMA_POOL_TIMEOUT_SECONDS ?? '15',
      );
    }

    super({
      datasources: { db: { url: databaseUrl.toString() } },
      log:
        process.env.NODE_ENV === 'development'
          ? ['warn', 'error']
          : ['error'],
    });
  }
  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
