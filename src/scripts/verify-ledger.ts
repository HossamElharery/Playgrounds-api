/**
 * Verify venue ledger integrity. Safe to run in production (read-only unless --repair).
 *
 *   npx ts-node src/scripts/verify-ledger.ts
 *   npx ts-node src/scripts/verify-ledger.ts --repair
 *   npx ts-node src/scripts/verify-ledger.ts --venue <uuid>
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../modules/app/app.module';
import { LedgerService } from '../modules/finance/ledger.service';
import { PrismaService } from '../modules/prisma/prisma.service';

async function main() {
  const repair = process.argv.includes('--repair');
  const venueFlag = process.argv.indexOf('--venue');
  const venueId = venueFlag >= 0 ? process.argv[venueFlag + 1] : undefined;

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  const ledger = app.get(LedgerService);
  const prisma = app.get(PrismaService);

  const venues = venueId
    ? [{ id: venueId }]
    : await prisma.venue.findMany({ select: { id: true } });

  let dirty = 0;
  for (const venue of venues) {
    const report = await ledger.verifyLedgerIntegrity(venue.id);
    if (!report.ok) {
      dirty += 1;
      process.stdout.write(JSON.stringify({ venueId: venue.id, ...report }, null, 2) + '\n');
      if (repair) {
        for (const issue of report.issues) {
          if (!issue.bookingId) continue;
          await prisma.$transaction((tx) =>
            ledger.syncBookingLedger(tx, issue.bookingId!, 'cli_repair'),
          );
        }
        const after = await ledger.verifyLedgerIntegrity(venue.id);
        process.stdout.write(JSON.stringify({ venueId: venue.id, repaired: after }, null, 2) + '\n');
      }
    }
  }
  await app.close();
  if (dirty > 0 && !repair) process.exit(1);
}

void main();
