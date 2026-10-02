/**
 * Live check of the Excel import against a real (dev) database: reads a workbook, previews it,
 * imports it as one batch, proves history never lands in a cash drawer, re-imports (duplicates),
 * then undoes the batch and removes everything it created. Refuses to run in production.
 *
 *   npx ts-node src/scripts/qa-import-live.ts
 */
/* eslint-disable no-console */
import type { AuthenticatedUser } from '../common/types/authenticated-user.interface';

function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  → ${JSON.stringify(detail)}`}`);
  if (!ok) process.exitCode = 1;
}

async function main() {
  if (process.env.NODE_ENV === 'production') throw new Error('refusing to run in production');
  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = await import('../modules/app/app.module');
  const { PrismaService } = await import('../modules/prisma/prisma.service');
  const { ImportService } = await import('../modules/owner/import/import.service');
  const { OwnerSummaryService } = await import('../modules/owner/owner-summary.service');
  const { CashService } = await import('../modules/owner/cash/cash.service');
  const { buildXlsx } = await import('../common/utils/tabular-export.util');

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const prisma = app.get(PrismaService);
  const imports = app.get(ImportService);
  const summary = app.get(OwnerSummaryService);
  const cash = app.get(CashService);
  let batchId: string | null = null;
  try {
    const court = await prisma.court.findFirst({
      where: { venue: { owner: { roles: { has: 'owner' } } } },
      include: { venue: { include: { owner: true } } },
    });
    if (!court) throw new Error('no venue with a court in this database');
    const owner: AuthenticatedUser = { id: court.venue.ownerId, phone: '', name: court.venue.owner.name ?? 'Owner', roles: ['owner'] };
    const venueId = court.venueId;
    const ymd = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10).split('-').reverse().join('/');
    const past = ymd(-400);
    const future = ymd(300);
    const file = {
      originalname: 'حجوزات.xlsx',
      buffer: Buffer.from(
        buildXlsx([
          {
            name: 'الحجوزات',
            columns: ['التاريخ', 'الساعة', 'الملعب', 'اسم العميل', 'رقم الموبايل', 'السعر', 'المدفوع', 'طريقة الدفع'].map((header) => ({ header })),
            rows: [
              [past, '3 ص', court.name, 'QA أحمد', '٠١٠٠٠٠٠٠٠٠١', 300, 300, 'كاش'],
              [future, '3 ص', court.name, 'QA محمود', '01000000002', 400, 100, 'انستاباي'],
              [past, '3:30 ص', court.name, 'QA يتداخل', '', 200, 200, ''],
              [past, '9 ص', 'ملعب مش موجود', 'QA غلط', '', 200, 200, ''],
              ['كذا', '9 ص', court.name, 'QA تاريخ', '', 200, 200, ''],
            ],
          },
        ]),
      ),
    };
    const config = JSON.stringify({ venueId, kind: 'bookings', options: { ambiguousHours: 'am' } });

    const p = await imports.preview(owner, file, config);
    check('detects the Arabic headers by itself', p.mapping.date === 0 && p.mapping.time === 1 && p.mapping.court === 2 && p.mapping.price === 5, p.mapping);
    const by = (n: number) => p.rows.find((r) => r.row === n)!;
    check('good rows are ok', by(2).status !== 'error' && by(3).status !== 'error', p.rows.map((r) => [r.row, r.status, r.issues]));
    check('a row inside another row is an in-file overlap', by(4).issues.some((i) => i.code === 'OVERLAP_FILE'), by(4));
    check('an unknown court is named', by(5).issues.some((i) => i.code === 'COURT_UNKNOWN'), by(5));
    check('a bad date is flagged', by(6).issues.some((i) => i.code === 'DATE_INVALID'), by(6));
    check('summary counts importable rows and money', p.summary.importable === 2 && p.summary.price === 70000 && p.summary.paid === 40000, p.summary);

    const before = await cash.drawer(owner, venueId);
    const result = await imports.commit(owner, file, config);
    batchId = result.batchId;
    check('commit creates exactly the two good rows', result.created === 2 && result.failed.length === 0, result);

    const rows = await prisma.booking.findMany({ where: { importBatchId: batchId }, include: { payments: true }, orderBy: { slotStart: 'asc' } });
    check('they are manual bookings tagged with the batch', rows.length === 2 && rows.every((b) => b.source === 'manual' && b.sourceLabel === 'استيراد من Excel'), rows.map((b) => [b.source, b.sourceLabel]));
    check('phones are canonical (+20…)', rows[0].guestPhone === '+201000000001', rows[0].guestPhone);
    const paid = rows[0].payments[0];
    check('history money is dated by the game, not by today', !!paid && paid.createdAt.getTime() === rows[0].slotStart.getTime(), [paid?.createdAt, rows[0].slotStart]);
    check('imported money is nobody\'s open drawer', rows.every((b) => b.payments.every((x) => x.recordedByUserId === null && x.shiftId === null)));
    check('the deposit row is partial with 100 received', rows[1].paymentStatus === 'partial' && rows[1].payments[0]?.amount === 10000, [rows[1].paymentStatus, rows[1].payments]);

    const after = await cash.drawer(owner, venueId);
    check('the cash drawer did not move', JSON.stringify((after.mine as { cash: unknown }).cash) === JSON.stringify((before.mine as { cash: unknown }).cash));

    const day = rows[0].slotStart.toISOString().slice(0, 10);
    const s = await summary.getSummary(owner, venueId, 'custom', day, day);
    check('the old game day now shows the revenue in reports', s.totals.ownRevenue >= 30000, s.totals);

    const again = await imports.preview(owner, file, config);
    check('importing the same file again flags duplicates instead of doubling', again.summary.duplicates === 2 && again.summary.importable === 0, again.summary);

    const undone = await imports.undo(owner, batchId);
    check('undo removes the whole batch', undone.removed === 2, undone);
    const left = await prisma.booking.count({ where: { importBatchId: batchId } });
    check('nothing is left behind', left === 0, left);
    batchId = null;
  } finally {
    if (batchId) await prisma.booking.deleteMany({ where: { importBatchId: batchId } });
    await prisma.venueImportBatch.deleteMany({ where: { fileName: 'حجوزات.xlsx' } });
    await app.close();
  }
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
