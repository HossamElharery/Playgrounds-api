/**
 * Numeric verification for Owner OS + Admin Finance.
 * Refuses to run when NODE_ENV=production.
 *
 *   npx ts-node src/scripts/qa-seed-and-verify.ts
 *   npx ts-node src/scripts/qa-seed-and-verify.ts --live
 */
import { verifyNumericCases } from './qa-numeric-cases';

async function liveVerify(): Promise<boolean> {
  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = await import('../modules/app/app.module');
  const { LedgerService } = await import('../modules/finance/ledger.service');
  const { PrismaService } = await import('../modules/prisma/prisma.service');
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    const ledger = app.get(LedgerService);
    const prisma = app.get(PrismaService);
    const venues = await prisma.venue.findMany({ select: { id: true, nameEn: true } });
    let dirty = 0;
    for (const venue of venues) {
      const report = await ledger.verifyLedgerIntegrity(venue.id);
      const balance = await ledger.getBalance(venue.id, 'EGP');
      process.stdout.write(
        JSON.stringify({ venueId: venue.id, name: venue.nameEn, ok: report.ok, balance, issues: report.issues.length }) +
          '\n',
      );
      if (!report.ok) dirty += 1;
    }
    return dirty === 0;
  } finally {
    await app.close();
  }
}

async function main() {
  if (process.env.NODE_ENV === 'production') {
    process.stderr.write('qa-seed-and-verify refuses to run when NODE_ENV=production\n');
    process.exit(1);
  }

  const rows = verifyNumericCases();
  process.stdout.write('id\tlabel\tok\texpected\tactual\n');
  let failed = 0;
  for (const row of rows) {
    if (!row.ok) failed += 1;
    process.stdout.write(
      `${row.id}\t${row.label}\t${row.ok ? 'PASS' : 'FAIL'}\t${JSON.stringify(row.expected)}\t${JSON.stringify(row.actual)}\n`,
    );
  }

  if (process.argv.includes('--live')) {
    const liveOk = await liveVerify();
    if (!liveOk) failed += 1;
  }

  if (failed > 0) process.exit(1);
}

void main();
