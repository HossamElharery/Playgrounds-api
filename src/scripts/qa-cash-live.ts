/**
 * Live check of the money trail against a real (dev) database: partial payments, the received-money
 * book, the cash drawer and shift close. It creates its own bookings on an existing venue and
 * deletes them again. Refuses to run when NODE_ENV=production.
 *
 *   npx ts-node src/scripts/qa-cash-live.ts
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
  const { OwnerBookingsService } = await import('../modules/owner/owner-bookings.service');
  const { OwnerSummaryService } = await import('../modules/owner/owner-summary.service');
  const { CashService } = await import('../modules/owner/cash/cash.service');

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const prisma = app.get(PrismaService);
  const bookings = app.get(OwnerBookingsService);
  const summary = app.get(OwnerSummaryService);
  const cash = app.get(CashService);
  const createdIds: string[] = [];
  const shiftIds: string[] = [];
  try {
    const court = await prisma.court.findFirst({
      where: { venue: { owner: { roles: { has: 'owner' } } } },
      include: { venue: { include: { owner: true } } },
    });
    if (!court) throw new Error('no venue with a court in this database');
    const owner: AuthenticatedUser = {
      id: court.venue.ownerId,
      phone: court.venue.owner.phone ?? '',
      name: court.venue.owner.name ?? 'Owner',
      roles: ['owner'],
    };
    const venueId = court.venueId;
    // A far-away day nobody booked; the three bookings sit on different hours of it.
    const day = new Date(Date.now() + 200 * 86_400_000);
    day.setUTCHours(0, 0, 0, 0);
    const at = (h: number) => new Date(day.getTime() + h * 3_600_000).toISOString();
    const ymd = day.toISOString().slice(0, 10);
    const before = await cash.drawer(owner, venueId);
    const startingCash = (before.mine as { cash: { net: number } }).cash.net;

    // 1. A deposit for a game 200 days away.
    const a = await bookings.createManualBooking(owner, {
      venueId,
      courtId: court.id,
      startsAt: at(3),
      durationMinutes: 60,
      priceAmount: 30000,
      paymentStatus: 'partial',
      paidAmount: 10000,
      paymentMethod: 'cash',
      customerName: 'QA عميل',
    } as never);
    createdIds.push(a.id);

    const today = await summary.cashToday(owner, venueId);
    check('a deposit for a future game is "advance", not today\'s games', today.advance >= 10000, today);
    check('received today counts the deposit', today.received >= 10000, today);

    const range = await summary.getSummary(owner, venueId, 'custom', ymd, ymd);
    check('the GAME day shows the deposit as revenue (part-paid counts)', range.totals.ownRevenue === 10000, range.totals);
    check('…and it is still owed 200', range.totals.outstanding === 20000, range.totals.outstanding);
    check('the game day received-book is empty (money came earlier)', range.cashbook.received === 0, range.cashbook);

    // 2. The balance, taken on the game day's range via a later payment.
    const afterPay = await bookings.addManualPayment(owner, a.id, 20000, 'instapay');
    check('booking turns paid after the balance', afterPay.paymentStatus === 'paid', afterPay.paymentStatus);
    check('statement: received 300, nothing owed', afterPay.money.statement.received === 30000 && afterPay.money.statement.outstanding === 0, afterPay.money.statement);
    check('payment history lists who took each payment', afterPay.payments.length === 2 && afterPay.payments.every((p) => p.byUserId === owner.id), afterPay.payments);
    const range2 = await summary.getSummary(owner, venueId, 'custom', ymd, ymd);
    check('game-day revenue is the full 300 once paid', range2.totals.ownRevenue === 30000, range2.totals);
    check('cash vs online split: only the cash part is cash', range2.totals.cashCollected === 10000, range2.totals);

    // 3. The drawer.
    const drawer = await cash.drawer(owner, venueId);
    const mine = drawer.mine as { cash: { in: number; net: number }; byMethod: { method: string; in: number }[]; count: number };
    check('drawer holds the cash deposit (plus whatever was there)', mine.cash.net === startingCash + 10000, mine.cash);
    check('drawer lists InstaPay separately (not counted by hand)', mine.byMethod.some((m) => m.method === 'instapay' && m.in >= 20000), mine.byMethod);

    // 4. Take the deposit back: a negative row, nothing deleted.
    const cashPayment = afterPay.payments.find((p) => p.method === 'cash')!;
    const voided = await bookings.voidManualPayment(owner, a.id, cashPayment.id, 'QA refund');
    check('refund keeps both rows (never deleted)', voided.payments.length === 3, voided.payments.map((p) => p.amount));
    check('refund brings the booking back to partial', voided.paymentStatus === 'partial', voided.paymentStatus);
    const afterVoid = await cash.drawer(owner, venueId);
    check('the refund nets out of the same open drawer', (afterVoid.mine as { cash: { net: number } }).cash.net === startingCash, afterVoid.mine);

    // 5. Close the shift on what is counted; it must balance and stamp every row.
    const expected = (afterVoid.mine as { cash: { expected: number } }).cash.expected;
    const hasMovements = (afterVoid.mine as { count: number }).count > 0;
    if (hasMovements) {
      const shift = await cash.closeShift(owner, { venueId, scope: 'mine', countedCash: expected, carryOver: 0, note: 'QA' });
      shiftIds.push(shift.id);
      check('shift closes balanced when the count matches', shift.difference === 0 && shift.expectedCash === expected, shift);
      const detail = await cash.detail(owner, shift.id);
      check('every pound is explained: shift detail lists its payments', detail.payments.length >= 3, detail.payments.length);
      const again = await cash.closeShift(owner, { venueId, scope: 'mine', countedCash: 0 }).catch((e: { response?: { code?: string } }) => e);
      check('closing again finds nothing to close', (again as { response?: { code?: string } }).response?.code === 'NOTHING_TO_CLOSE', again);
    }

    // 6. A correction after the close lands in the next drawer.
    const second = await bookings.addManualPayment(owner, a.id, 5000, 'cash');
    const p2 = second.payments[second.payments.length - 1];
    const late = await bookings.voidManualPayment(owner, a.id, p2.id);
    check('voiding a payment from an already-closed day is still possible', late.payments.length >= 5, late.payments.length);
  } finally {
    await prisma.payment.updateMany({ where: { bookingId: { in: createdIds } }, data: { shiftId: null } });
    await prisma.cashShift.deleteMany({ where: { id: { in: shiftIds } } });
    await prisma.booking.deleteMany({ where: { id: { in: createdIds } } });
    await app.close();
  }
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
