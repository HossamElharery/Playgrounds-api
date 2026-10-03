/**
 * Real-Postgres integration tests for the owner finance stack
 * (bookings → snapshots → ledger → owner summary).
 * Run with `npm run test:integration` (creates and drops a throwaway database).
 * Refuses to run unless the target database name contains "test" or "tmp".
 */
const dbUrl = process.env.TEST_DATABASE_URL ?? '';
const dbName = dbUrl.split('?')[0].split('/').pop() ?? '';
if (!/(test|tmp)/.test(dbName)) {
  throw new Error(`Refusing to run integration tests against "${dbName}" (name must contain test/tmp)`);
}
process.env.DATABASE_URL = dbUrl;

import { PrismaService } from '../src/modules/prisma/prisma.service';
import { OwnerSummaryService } from '../src/modules/owner/owner-summary.service';
import { LedgerService } from '../src/modules/finance/ledger.service';
import { CommissionService } from '../src/modules/finance/commission.service';
import { zonedWallTimeToUtc } from '../src/common/utils/timezone.util';
import type { AuthenticatedUser } from '../src/common/types/authenticated-user.interface';

const TZ = 'Africa/Cairo';
jest.setTimeout(120_000);

function rng(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function localParts(instant: Date) {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
  }).formatToParts(instant);
  const m: Record<string, string> = {};
  for (const p of f) if (p.type !== 'literal') m[p.type] = p.value;
  return { date: `${m.year}-${m.month}-${m.day}`, hour: Number(m.hour) };
}

describe('finance integration (real Postgres)', () => {
  const prisma = new PrismaService();
  const summary = new OwnerSummaryService(prisma);
  const ledger = new LedgerService(prisma, new CommissionService(prisma, {} as never));
  let owner: AuthenticatedUser;
  let sportId: string;
  let seq = 0;

  async function makeVenue(label: string) {
    const user = await prisma.user.create({
      data: { name: `Owner ${label}`, phone: `+2011${String(++seq).padStart(8, '0')}`, roles: ['owner'] },
    });
    const venue = await prisma.venue.create({
      data: {
        slug: `it-${label}-${seq}`,
        ownerId: user.id,
        nameEn: label,
        nameAr: label,
        lat: 30,
        lng: 31,
        geohash: 'sv8wr',
        status: 'active',
        priceFromCurrency: 'EGP',
      },
    });
    const courts: Awaited<ReturnType<typeof prisma.court.create>>[] = [];
    for (let i = 1; i <= 3; i += 1) {
      courts.push(await prisma.court.create({ data: { venueId: venue.id, sportId, name: `Unit ${i}` } }));
    }
    return {
      venue,
      courts,
      user: { id: user.id, phone: user.phone!, name: user.name, roles: ['owner'] } as AuthenticatedUser,
    };
  }

  type Row = {
    courtId: string;
    slotStart: Date;
    slotEnd: Date;
    source: 'platform' | 'manual';
    mode: 'online' | 'at_venue' | null;
    status: 'confirmed' | 'completed' | 'cancelled' | 'no_show' | 'held';
    paymentStatus: 'paid' | 'pending' | 'refunded' | 'partial';
    checkedIn: boolean;
    base: number;
    ownerDisc: number;
    bps: number;
    sourceKey?: string;
    method?: 'cash' | 'instapay' | 'card';
  };

  async function insert(venueId: string, userId: string, r: Row, i: number) {
    const fee = r.source === 'platform' ? Math.round(r.base * 0.05) : 0;
    const total = r.base + fee - r.ownerDisc;
    const gross = r.base - r.ownerDisc;
    const commission = r.source === 'platform' ? Math.round((gross * r.bps) / 10000) : null;
    return prisma.booking.create({
      data: {
        code: `IT-${venueId.slice(0, 6)}-${i}-${Math.random().toString(36).slice(2, 8)}`,
        venueId,
        courtId: r.courtId,
        userId,
        slotStart: r.slotStart,
        slotEnd: r.slotEnd,
        baseAmount: r.base,
        feeAmount: fee,
        discountAmount: r.ownerDisc,
        ownerFundedDiscount: r.source === 'platform' ? r.ownerDisc : 0,
        totalAmount: total,
        source: r.source,
        sourceKey: r.source === 'manual' ? (r.sourceKey ?? 'walk_in') : null,
        paymentModeSnapshot: r.source === 'platform' ? r.mode : null,
        paymentMethod: r.method ?? (r.mode === 'online' ? 'card' : 'cash'),
        paymentStatus: r.paymentStatus,
        status: r.status,
        checkedInAt: r.checkedIn ? r.slotStart : null,
        commissionBps: r.source === 'platform' ? r.bps : null,
        commissionAmount: commission,
        ownerNetAmount: commission == null ? null : gross - commission,
        guestName: r.source === 'manual' ? `Guest ${i % 7}` : null,
      },
    });
  }

  /** Independent re-derivation of the money model (00 §4) — no shared helpers. */
  function expectedRevenue(r: Row): number {
    if (r.status === 'cancelled' || r.status === 'held') return 0;
    if (r.source === 'platform') {
      const collected =
        r.mode === 'online'
          ? r.paymentStatus === 'paid' && ['confirmed', 'completed', 'no_show'].includes(r.status)
          : r.status === 'completed' || r.checkedIn;
      return collected ? Math.max(0, r.base - r.ownerDisc) : 0;
    }
    return r.paymentStatus === 'paid' ? r.base : 0;
  }

  beforeAll(async () => {
    await prisma.$connect();
    const sport = await prisma.sportCategory.findFirstOrThrow();
    sportId = sport.id;
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('applies the migration seed: global commission row = 1000 bps', async () => {
    const row = await prisma.commissionSetting.findFirst({ where: { venueId: null } });
    expect(row?.percentageBps).toBe(1000);
  });

  it('timezone: bookings around local midnight land on the right civil day/hour (incl. DST switch)', async () => {
    const { venue, courts, user } = await makeVenue('tz');
    // Instants straddling local midnight, before/after the Oct-2026 DST change.
    const instants = [
      '2026-09-20T20:59:00Z', // 23:59 local (UTC+3)
      '2026-09-20T21:00:00Z', // 00:00 next day local
      '2026-09-20T21:30:00Z', // 00:30 next day local
      '2026-10-29T20:59:00Z',
      '2026-10-29T21:30:00Z',
      '2026-10-29T22:30:00Z',
      '2026-10-30T22:30:00Z',
    ].map((s) => new Date(s));
    const rows: Row[] = instants.map((slotStart, i) => ({
      courtId: courts[i % 3].id,
      slotStart,
      slotEnd: new Date(slotStart.getTime() + 25 * 60_000),
      source: 'manual',
      mode: null,
      status: 'confirmed',
      paymentStatus: 'paid',
      checkedIn: false,
      base: 100 + i,
      ownerDisc: 0,
      bps: 1000,
    }));
    for (let i = 0; i < rows.length; i += 1) await insert(venue.id, user.id, rows[i], i);
    const out = await summary.getSummary(user, venue.id, 'custom', '2026-09-19', '2026-11-01');
    for (const r of rows) {
      const { date, hour } = localParts(r.slotStart);
      const day = out.byDay.find((d) => d.date === date);
      expect(day?.revenue).toBeGreaterThanOrEqual(r.base);
      const h = out.byHour.find((x) => x.hour === hour);
      expect(h?.revenue).toBeGreaterThanOrEqual(r.base);
    }
    // the 23:59 booking and the 00:00 booking must be on different days
    expect(out.byDay.find((d) => d.date === '2026-09-20')?.revenue).toBe(100);
    expect(out.byDay.find((d) => d.date === '2026-09-21')?.revenue).toBe(101 + 102);
    expect(out.byHour.find((x) => x.hour === 0)?.bookings).toBeGreaterThanOrEqual(2);
  });

  it('invariant: every breakdown adds up to the headline total (200 random bookings)', async () => {
    const { venue, courts, user } = await makeVenue('inv');
    const rand = rng(20260920);
    const slots: { court: number; day: number; hour: number }[] = [];
    for (let c = 0; c < 3; c += 1) for (let d = 0; d < 10; d += 1) for (let h = 0; h < 24; h += 1) slots.push({ court: c, day: d, hour: h });
    for (let i = slots.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rand() * (i + 1));
      [slots[i], slots[j]] = [slots[j], slots[i]];
    }
    const pick = <T,>(arr: T[]) => arr[Math.floor(rand() * arr.length)];
    const rows: Row[] = slots.slice(0, 200).map((s) => {
      const date = `2026-09-${String(1 + s.day).padStart(2, '0')}`;
      const slotStart = zonedWallTimeToUtc(date, `${String(s.hour).padStart(2, '0')}:00`, TZ);
      const source = rand() < 0.6 ? 'platform' : 'manual';
      const base = pick([200, 250, 300, 333, 335, 400, 500]);
      return {
        courtId: courts[s.court].id,
        slotStart,
        slotEnd: new Date(slotStart.getTime() + 60 * 60_000),
        source,
        mode: source === 'platform' ? pick(['online', 'at_venue'] as const) : null,
        status: pick(['confirmed', 'completed', 'completed', 'cancelled', 'no_show'] as const),
        paymentStatus: pick(['paid', 'paid', 'pending', 'refunded'] as const),
        checkedIn: rand() < 0.4,
        base,
        ownerDisc: source === 'platform' && rand() < 0.2 ? 50 : 0,
        bps: pick([1000, 1000, 1250]),
        sourceKey: pick(['walk_in', 'phone', 'whatsapp']),
        method: pick(['cash', 'cash', 'instapay', 'card'] as const),
      } as Row;
    });
    for (let i = 0; i < rows.length; i += 1) await insert(venue.id, user.id, rows[i], i);

    const out = await summary.getSummary(user, venue.id, 'custom', '2026-09-01', '2026-09-10');

    const countable = rows.filter((r) => ['confirmed', 'completed', 'no_show'].includes(r.status));
    const expectedTotal = rows.reduce((s, r) => s + expectedRevenue(r), 0);
    const expMatchena = rows.filter((r) => r.source === 'platform').reduce((s, r) => s + expectedRevenue(r), 0);
    const expCommission = rows
      .filter((r) => r.source === 'platform' && expectedRevenue(r) > 0)
      .reduce((s, r) => s + Math.round(((r.base - r.ownerDisc) * r.bps) / 10000), 0);

    expect(out.totals.bookings).toBe(countable.length);
    expect(out.totals.collectedRevenue).toBe(expectedTotal);
    expect(out.totals.matchenaRevenue).toBe(expMatchena);
    expect(out.totals.ownRevenue).toBe(expectedTotal - expMatchena);
    expect(out.totals.commission).toBe(expCommission);
    expect(out.totals.takeHome).toBe(expectedTotal - expCommission);
    expect(out.totals.cashCollected + out.totals.onlineCollected).toBe(expectedTotal);

    const sum = (xs: { revenue: number }[]) => xs.reduce((s, x) => s + x.revenue, 0);
    expect(sum(out.byDay)).toBe(expectedTotal);
    expect(sum(out.byHour)).toBe(expectedTotal);
    expect(sum(out.byUnit)).toBe(expectedTotal);
    expect(sum(out.bySource)).toBe(expectedTotal);
    expect(out.byDay.reduce((s, d) => s + d.bookings, 0)).toBe(countable.length);
    expect(out.byUnit.reduce((s, u) => s + u.bookings, 0)).toBe(countable.length);

    // per-day and per-hour buckets equal an independent Intl-based grouping
    const perDay = new Map<string, number>();
    const perHour = new Map<number, number>();
    for (const r of rows) {
      const { date, hour } = localParts(r.slotStart);
      perDay.set(date, (perDay.get(date) ?? 0) + expectedRevenue(r));
      perHour.set(hour, (perHour.get(hour) ?? 0) + expectedRevenue(r));
    }
    for (const d of out.byDay) expect(d.revenue).toBe(perDay.get(d.date) ?? 0);
    for (const h of out.byHour) expect(h.revenue).toBe(perHour.get(h.hour) ?? 0);
    // the player service fee must never leak into owner revenue
    const fees = rows.filter((r) => r.source === 'platform').reduce((s, r) => s + Math.round(r.base * 0.05), 0);
    expect(fees).toBeGreaterThan(0);
  });

  it('ledger: accrual per mode, reversal on refund, idempotent + concurrency-safe, integrity clean', async () => {
    const { venue, courts, user } = await makeVenue('led');
    const t0 = new Date('2026-09-15T10:00:00Z');
    const at = (i: number) => ({ slotStart: new Date(t0.getTime() + i * 3 * 3600_000), slotEnd: new Date(t0.getTime() + i * 3 * 3600_000 + 3600_000) });
    const base = { source: 'platform' as const, ownerDisc: 0, bps: 1000, base: 400 };
    const online = await insert(venue.id, user.id, { ...base, courtId: courts[0].id, ...at(0), mode: 'online', status: 'confirmed', paymentStatus: 'paid', checkedIn: false }, 1);
    const atVenue = await insert(venue.id, user.id, { ...base, courtId: courts[1].id, ...at(1), mode: 'at_venue', status: 'completed', paymentStatus: 'pending', checkedIn: true }, 2);
    const notYet = await insert(venue.id, user.id, { ...base, courtId: courts[2].id, ...at(2), mode: 'at_venue', status: 'confirmed', paymentStatus: 'pending', checkedIn: false }, 3);
    const manual = await insert(venue.id, user.id, { ...base, source: 'manual', mode: null, courtId: courts[0].id, ...at(3), status: 'confirmed', paymentStatus: 'paid', checkedIn: false }, 4);

    for (const id of [online.id, atVenue.id, notYet.id, manual.id]) {
      await prisma.$transaction((tx) => ledger.syncBookingLedger(tx, id));
    }
    expect(await ledger.getBalance(venue.id)).toBe(360 - 60); // +360 online, −60 at-venue, 0 others

    // idempotent
    await prisma.$transaction((tx) => ledger.syncBookingLedger(tx, online.id));
    expect(await ledger.getBalance(venue.id)).toBe(300);

    // concurrent double-sync after a refund writes exactly one reversal
    await prisma.booking.update({ where: { id: online.id }, data: { paymentStatus: 'refunded', status: 'cancelled' } });
    await Promise.all([
      prisma.$transaction((tx) => ledger.syncBookingLedger(tx, online.id)),
      prisma.$transaction((tx) => ledger.syncBookingLedger(tx, online.id)),
    ]);
    expect(await ledger.getBalance(venue.id)).toBe(-60);
    const entries = await prisma.venueLedgerEntry.count({ where: { bookingId: online.id } });
    expect(entries).toBe(2); // accrual + one adjustment

    // manual bookings never touch the ledger
    expect(await prisma.venueLedgerEntry.count({ where: { bookingId: manual.id } })).toBe(0);

    const report = await ledger.verifyLedgerIntegrity(venue.id);
    expect(report.ok).toBe(true);
    expect(report.balance).toBe(-60);
  });

  it('performance: 20k bookings — /owner/summary p95 within budget, one round of queries', async () => {
    const { venue, courts, user } = await makeVenue('perf');
    const rand = rng(7);
    const rows: Record<string, unknown>[] = [];
    let n = 0;
    for (let day = 0; day < 290 && n < 20_000; day += 1) {
      const ymd = new Date(Date.UTC(2025, 0, 1 + day)).toISOString().slice(0, 10);
      for (let hour = 0; hour < 24 && n < 20_000; hour += 1) {
        for (const court of courts) {
          if (n >= 20_000) break;
          const slotStart = zonedWallTimeToUtc(ymd, `${String(hour).padStart(2, '0')}:00`, TZ);
          const platform = rand() < 0.5;
          rows.push({
            code: `PF-${n}`,
            venueId: venue.id,
            courtId: court.id,
            userId: user.id,
            slotStart,
            slotEnd: new Date(slotStart.getTime() + 3600_000),
            baseAmount: 300,
            feeAmount: platform ? 15 : 0,
            totalAmount: platform ? 315 : 300,
            source: platform ? 'platform' : 'manual',
            sourceKey: platform ? null : 'walk_in',
            paymentModeSnapshot: platform ? 'at_venue' : null,
            paymentMethod: 'cash',
            paymentStatus: platform ? 'pending' : 'paid',
            status: 'completed',
            checkedInAt: platform ? slotStart : null,
            commissionBps: platform ? 1000 : null,
            commissionAmount: platform ? 30 : null,
            ownerNetAmount: platform ? 270 : null,
          });
          n += 1;
        }
      }
    }
    for (let i = 0; i < rows.length; i += 1000) {
      await prisma.booking.createMany({ data: rows.slice(i, i + 1000) as never });
    }
    expect(await prisma.booking.count({ where: { venueId: venue.id } })).toBe(20_000);

    const times: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      const t = process.hrtime.bigint();
      await summary.getSummary(user, venue.id, 'custom', '2025-01-01', '2025-10-17');
      times.push(Number(process.hrtime.bigint() - t) / 1e6);
    }
    times.sort((a, b) => a - b);
    const p50 = times[9];
    const p95 = times[18];
    // eslint-disable-next-line no-console
    console.log(`summary 20k bookings: p50=${p50.toFixed(0)}ms p95=${p95.toFixed(0)}ms`);
    expect(p95).toBeLessThan(1000);
  });

  it('board: a booking that does not start on a slot boundary still has a head cell', async () => {
    const { OwnerService } = await import('../src/modules/owner/owner.service');
    const { venue, courts, user } = await makeVenue('board');
    await prisma.venue.update({ where: { id: venue.id }, data: { weeklyHours: Object.fromEntries([0,1,2,3,4,5,6].map(day => [String(day), { open: '08:00', close: '23:00', closed: false }])) } });
    // 15:53–16:53 Cairo spans the 15:00 and 16:00 hourly cells, starting inside the first.
    const slotStart = new Date('2026-09-20T12:53:00Z');
    await insert(
      venue.id,
      user.id,
      {
        courtId: courts[0].id,
        slotStart,
        slotEnd: new Date(slotStart.getTime() + 60 * 60_000),
        source: 'manual',
        mode: null,
        status: 'confirmed',
        paymentStatus: 'paid',
        checkedIn: false,
        base: 12000,
        ownerDisc: 0,
        bps: 1000,
      },
      99,
    );
    const { NestFactory } = await import('@nestjs/core');
    const { AppModule } = await import('../src/modules/app/app.module');
    const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
    let board: { courts: { court: { id: string }; slots: Record<string, unknown>[] }[] };
    try {
      board = await app.get(OwnerService).board(user, venue.id, '2026-09-20');
    } finally {
      await app.close();
    }
    const row = board.courts.find((c) => c.court.id === courts[0].id)!;
    const heads = row.slots.filter((slot) => slot['bookingId'] && Number(slot['spanSlots']) > 0);
    expect(heads.length).toBe(1);
    expect(heads[0]['state']).toBe('booked_manual');
    expect(heads[0]['spanSlots']).toBe(2);
  });
  async function operationFixture(label: string, total = 40025) {
    const f = await makeVenue(label);
    await prisma.venue.update({ where: { id: f.venue.id }, data: { weeklyHours: Object.fromEntries([0,1,2,3,4,5,6].map(d => [String(d), { open: '00:00', close: '23:45', closed: false }])) } });
    const { OwnerBookingsService } = await import('../src/modules/owner/owner-bookings.service');
    const service = new OwnerBookingsService(prisma, ledger, new CommissionService(prisma, {} as never), { create: async () => ({}) } as never);
    const starts = new Date(Date.now() + 7 * 86400000); starts.setUTCHours(12, 0, 0, 0);
    const dto = { venueId: f.venue.id, courtId: f.courts[0].id, startsAt: starts.toISOString(), durationMinutes: 60, priceAmount: total, paymentStatus: 'unpaid' as const, customerName: 'Integration guest' };
    const booking = await service.createManualBooking(f.user, dto);
    return { ...f, service, booking, dto };
  }

  it('keeps cents exact through deposit, balance, refund, cancellation and cash reporting', async () => {
    const { service, booking, user, venue } = await operationFixture('money-lifecycle');
    let b = await service.addManualPayment(user, booking.id, 10005, 'cash');
    expect(b.money).toMatchObject({ total: 40025, paidAmount: 10005, outstanding: 30020 });
    b = await service.addManualPayment(user, booking.id, 30020, 'instapay');
    expect(b.money).toMatchObject({ paidAmount: 40025, outstanding: 0 });
    const payments = await prisma.payment.findMany({ where: { bookingId: booking.id, amount: { gt: 0 } } });
    for (const payment of payments) await service.voidManualPayment(user, booking.id, payment.id);
    b = await service.getBooking(user, booking.id);
    expect(b.money).toMatchObject({ total: 40025, paidAmount: 0, outstanding: 40025 });
    await service.deleteManualBooking(user, booking.id);
    const cash = await summary.cashbook(venue.id, new Date(Date.now() - 3600000), new Date(Date.now() + 3600000));
    expect(cash.received).toBe(0);
    expect(cash.refunds).toBe(40025);
    expect(await prisma.payment.count({ where: { bookingId: booking.id } })).toBe(4);
  });

  it('rejects zero, negative and fractional payment amounts at the service boundary without writes', async () => {
    const { service, booking, user } = await operationFixture('invalid-money');
    for (const amount of [0, -1, -40025, 0.5, NaN, Infinity]) {
      await expect(service.addManualPayment(user, booking.id, amount, 'cash')).rejects.toBeDefined();
    }
    expect(await prisma.payment.count({ where: { bookingId: booking.id } })).toBe(0);
  });

  it('concurrent full-balance payments never double collect and return a usable refusal', async () => {
    for (let i = 0; i < 8; i++) {
      const { service, booking, user } = await operationFixture(`parallel-payment-${i}`);
      const outcomes = await Promise.allSettled([service.addManualPayment(user, booking.id, 40025, 'cash'), service.addManualPayment(user, booking.id, 40025, 'cash')]);
      expect(outcomes.filter(r => r.status === 'fulfilled')).toHaveLength(1);
      const failed = outcomes.find(r => r.status === 'rejected') as PromiseRejectedResult;
      expect(typeof failed.reason.getStatus).toBe('function');
      expect([400, 409]).toContain(failed.reason.getStatus());
      const b = await service.getBooking(user, booking.id);
      expect(b.money.paidAmount).toBe(40025);
      expect(await prisma.payment.count({ where: { bookingId: booking.id } })).toBe(1);
    }
  });

  it('a duplicate refund cannot create two reversals, including concurrent requests', async () => {
    const { service, booking, user } = await operationFixture('parallel-refund');
    await service.addManualPayment(user, booking.id, 40025, 'cash');
    const payment = await prisma.payment.findFirstOrThrow({ where: { bookingId: booking.id } });
    const outcomes = await Promise.allSettled([service.voidManualPayment(user, booking.id, payment.id), service.voidManualPayment(user, booking.id, payment.id)]);
    expect(outcomes.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(await prisma.payment.count({ where: { reversesPaymentId: payment.id } })).toBe(1);
    const failed = outcomes.find(r => r.status === 'rejected') as PromiseRejectedResult;
    expect(typeof failed.reason.getStatus).toBe('function');
    expect([400, 409]).toContain(failed.reason.getStatus());
    expect((await service.getBooking(user, booking.id)).money.paidAmount).toBe(0);
  });

  it('concurrent booking creation cannot occupy the same unit twice', async () => {
    const { service, booking, user, dto } = await operationFixture('parallel-slot');
    await service.deleteManualBooking(user, booking.id);
    const outcomes = await Promise.allSettled(Array.from({length: 6}, () => service.createManualBooking(user, dto)));
    expect(outcomes.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(await prisma.booking.count({ where: { courtId: dto.courtId, status: 'confirmed' } })).toBe(1);
    for (const outcome of outcomes) if (outcome.status === 'rejected') {
      expect(typeof outcome.reason.getStatus).toBe('function');
      expect(outcome.reason.getStatus()).toBe(409);
    }
  });

  it('restoring a cancelled booking races safely with a new booking for the same slot', async () => {
    const { service, booking, user, dto } = await operationFixture('parallel-restore');
    await service.deleteManualBooking(user, booking.id);
    const outcomes = await Promise.allSettled([service.restoreManualBooking(user, booking.id), service.createManualBooking(user, dto)]);
    expect(outcomes.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(await prisma.booking.count({ where: { courtId: dto.courtId, status: 'confirmed' } })).toBe(1);
    for (const outcome of outcomes) if (outcome.status === 'rejected') {
      expect(typeof outcome.reason.getStatus).toBe('function');
      expect(outcome.reason.getStatus()).toBe(409);
    }
  });

  it('enforces staff payment permissions and delegated team scope on real database records', async () => {
    const f = await operationFixture('staff-permissions');
    const other = await makeVenue('other-scope');
    await prisma.venue.update({where:{id: other.venue.id},data:{ownerId:f.user.id}});
    const { TeamService } = await import('../src/modules/team/team.service');
    const team = new TeamService(prisma, {get:()=>4} as never, {emitToUser:jest.fn(),disconnectUser:jest.fn()} as never);
    const actor = await team.resolveActor(f.user);
    const create = (name: string, permissions: string[], venueIds: string[]) => team.create(actor,{name,email:`${name}@example.invalid`,password:'TestOnly123!',permissions,venueIds});
    const manager = await create('integration-manager',['bookings.view','team.manage'],[f.venue.id]);
    const booker = await create('integration-booker',['bookings.view','bookings.create','bookings.edit'],[f.venue.id]);
    const viewer = await create('integration-viewer',['bookings.view'],[f.venue.id]);
    const elsewhere = await create('integration-elsewhere',['bookings.view'],[other.venue.id]);
    const managerUser = {id:manager.userId,roles:['staff'],name:'Manager',phone:''} as AuthenticatedUser;
    const delegated = await team.resolveActor(managerUser);
    const listing = await team.list(delegated);
    expect(listing.venues.map(v=>v.id)).toEqual([f.venue.id]);
    expect(listing.members.map(m=>m.id)).toEqual(expect.arrayContaining([manager.id,viewer.id]));
    expect(listing.members.map(m=>m.id)).not.toContain(elsewhere.id);
    expect(listing.members.map(m=>m.id)).not.toContain(booker.id);
    await expect(team.create(delegated,{name:'Escalated',username:'integration_escalated',password:'TestOnly123!',permissions:['reports.view'],venueIds:[f.venue.id]})).rejects.toMatchObject({status:403});
    await expect(team.create(delegated,{name:'Wrong venue',username:'integration_wrong_venue',password:'TestOnly123!',permissions:['bookings.view'],venueIds:[other.venue.id]})).rejects.toMatchObject({status:403});
    const staff = {id:booker.userId,roles:['staff'],name:'Booker',phone:''} as AuthenticatedUser;
    await expect(f.service.createManualBooking(staff,{...f.dto,paymentStatus:'paid',startsAt:new Date(Date.now()+8*86400000).toISOString()})).rejects.toMatchObject({status:403});
    await expect(f.service.updateManualBooking(staff,f.booking.id,{paymentStatus:'paid'})).rejects.toMatchObject({status:403});
    await expect(f.service.addManualPayment(staff,f.booking.id,100)).rejects.toMatchObject({status:403});
    await team.update(actor,booker.id,{permissions:['bookings.view','payments.record']});
    await expect(f.service.addManualPayment(staff,f.booking.id,10005)).resolves.toMatchObject({money:{paidAmount:10005,outstanding:30020}});
    await team.update(actor,booker.id,{venueIds:[other.venue.id]});
    await expect(f.service.addManualPayment(staff,f.booking.id,100)).rejects.toMatchObject({status:403});
  });

});
