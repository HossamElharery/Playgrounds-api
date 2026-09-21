import { FixedBookingsService } from './fixed-bookings.service';
import { OwnerBookingsService } from '../owner-bookings.service';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.interface';
import { seriesDates, addDays, sessionWindow } from '../../../common/utils/fixed-series.util';

const owner: AuthenticatedUser = { id: 'o1', phone: '+2010', name: 'Owner', roles: ['owner'] };
const admin: AuthenticatedUser = { id: 'a1', phone: '+2011', name: 'Admin', roles: ['admin'] };

/** Tiny where-matcher covering exactly the filters the service uses. */
function matches(row: any, where: any): boolean {
  return Object.entries(where ?? {}).every(([k, v]: [string, any]) => {
    if (k === 'OR') return v.some((w: any) => matches(row, w));
    const val = row[k];
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('in' in v) return v.in.includes(val);
      if ('not' in v) return val !== v.not;
      if ('lt' in v && !(val < v.lt)) return false;
      if ('gt' in v && !(val > v.gt)) return false;
      if ('gte' in v && !(val >= v.gte)) return false;
      return true;
    }
    if (v instanceof Date) return val instanceof Date && val.getTime() === v.getTime();
    return val === v;
  });
}

function setup(opts: { tz?: string; rules?: any[] } = {}) {
  const bookings: any[] = [];
  const series: any[] = [];
  const payments: any[] = [];
  const blocks: any[] = [];
  const notices: any[] = [];
  let n = 0;
  const tz = opts.tz ?? 'Africa/Cairo';
  const rules = opts.rules ?? [
    { id: 'r', courtId: 'c1', label: 'base', daysOfWeek: [], startTime: '00:00', endTime: '24:00', priceAmount: 40000, currency: 'EGP', priority: 0, kind: 'base', validFrom: null, validUntil: null },
  ];
  const db: any = {
    venue: { findUnique: jest.fn(async () => ({ id: 'v1', ownerId: 'o1', weeklyHours: null, country: { timezone: tz } })) },
    court: { findUnique: jest.fn(async ({ where }: any) => (where.id === 'c1' || where.id === 'c2' ? { id: where.id, venueId: 'v1', pricingRules: rules } : null)) },
    calendarBlock: { findFirst: jest.fn(async ({ where }: any) => blocks.find((b) => b.startsAt < where.startsAt.lt && b.endsAt > where.endsAt.gt) ?? null) },
    booking: {
      findFirst: jest.fn(async ({ where }: any) => bookings.find((b) => matches(b, where)) ?? null),
      findMany: jest.fn(async ({ where }: any) => bookings.filter((b) => matches(b, where)).sort((a, b) => a.slotStart - b.slotStart)),
      findUnique: jest.fn(async () => null),
      create: jest.fn(async ({ data }: any) => { const row = { id: `b${++n}`, currency: 'EGP', status: 'confirmed', ...data }; bookings.push(row); return row; }),
      update: jest.fn(async ({ where, data }: any) => Object.assign(bookings.find((b) => b.id === where.id), data)),
    },
    payment: { create: jest.fn(async ({ data }: any) => { payments.push(data); return data; }) },
    venueBookingSource: { upsert: jest.fn() },
    recurringBookingSeries: {
      create: jest.fn(async ({ data }: any) => { const row = { id: `s${++n}`, status: 'active', conflictDates: [], skippedDates: [], ...data }; series.push(row); return row; }),
      findUnique: jest.fn(async ({ where }: any) => { const r = series.find((s) => s.id === where.id); return r ? { ...r } : null; }),
      findUniqueOrThrow: jest.fn(async ({ where }: any) => series.find((s) => s.id === where.id)),
      findMany: jest.fn(async ({ where }: any) => series.filter((s) => s.kind === 'manual' && s.status === where.status && (!where.venueId || s.venueId === where.venueId || typeof where.venueId === 'object'))),
      update: jest.fn(async ({ where, data }: any) => {
        const row = series.find((s) => s.id === where.id);
        for (const [k, v] of Object.entries<any>(data)) row[k] = v && typeof v === 'object' && !Array.isArray(v) && 'push' in v ? [...row[k], v.push] : v;
        return row;
      }),
    },
    $transaction: jest.fn(async (fn: any) => fn(db)),
  };
  const ledger: any = { syncBookingLedger: jest.fn(async () => 0) };
  const notifications: any = { create: jest.fn(async (x: any) => { notices.push(x); return x; }) };
  const ownerBookings = new OwnerBookingsService(db, ledger, {} as any, notifications);
  const svc = new FixedBookingsService(db, ownerBookings, ledger, notifications);
  return { svc, db, bookings, series, payments, blocks, notices, tz };
}

/** A start `days` from now at 20:00 Cairo, so the tests never depend on the calendar. */
function futureStart(tz: string, days = 3, hhmm = '20:00') {
  const d = addDays(new Date().toISOString().slice(0, 10), days);
  return sessionWindow(d, hhmm, 60, tz).start.toISOString();
}

const base = (tz: string, extra: object = {}) => ({
  venueId: 'v1', courtId: 'c1', startsAt: futureStart(tz), durationMinutes: 60, weeks: 4, ...extra,
});

describe('FixedBookingsService', () => {
  it('previews every date, with quoted prices and a clash flagged', async () => {
    const { svc, bookings, tz } = setup();
    const dto = base(tz);
    const second = new Date(new Date(dto.startsAt).getTime() + 7 * 86_400_000);
    bookings.push({ id: 'x', courtId: 'c1', status: 'confirmed', slotStart: second, slotEnd: new Date(second.getTime() + 3_600_000) });
    const out = await svc.preview(owner, dto);
    expect(out.sessions).toHaveLength(4);
    expect(out.sessions[0].priceAmount).toBe(40000);
    expect(out.conflicts).toEqual([out.sessions[1].date]);
    expect(out.sessions[1].conflict).toBe('SLOT_ALREADY_HELD');
  });

  it('books the free dates, skips the clash and records it once', async () => {
    const { svc, bookings, series, tz } = setup();
    const dto = base(tz);
    const second = new Date(new Date(dto.startsAt).getTime() + 7 * 86_400_000);
    bookings.push({ id: 'x', courtId: 'c1', status: 'confirmed', slotStart: second, slotEnd: new Date(second.getTime() + 3_600_000) });
    const out = await svc.create(owner, { ...dto, customerName: 'الأهلي' });
    expect(out.created).toBe(3);
    expect(out.conflicts).toHaveLength(1);
    const mine = bookings.filter((b) => b.recurringSeriesId);
    expect(mine.every((b) => b.source === 'manual' && b.paymentStatus === 'pending' && b.guestName === 'الأهلي')).toBe(true);
    expect(series[0].conflictDates).toEqual(out.conflicts);
  });

  it('rejects a first session in the past', async () => {
    const { svc, tz } = setup();
    await expect(
      svc.create(owner, { ...base(tz, { startsAt: futureStart(tz, -3) }), customerName: 'x' }),
    ).rejects.toMatchObject({ response: expect.objectContaining({ code: 'SLOT_IN_PAST' }) });
  });

  it('prepaid puts the deposit on the first session only, as a partial payment', async () => {
    const { svc, bookings, payments, tz } = setup();
    await svc.create(owner, { ...base(tz), customerName: 'x', paymentPlan: 'prepaid', prepaidAmount: 10000, paymentMethod: 'cash' });
    const [first, ...rest] = bookings.filter((b) => b.recurringSeriesId);
    expect(first.paymentStatus).toBe('partial');
    expect(rest.every((b) => b.paymentStatus === 'pending')).toBe(true);
    expect(payments).toHaveLength(1);
    expect(payments[0].amount).toBe(10000);
  });

  it('skipping one date cancels only that session and keeps the rest', async () => {
    const { svc, bookings, tz } = setup();
    const made = await svc.create(owner, { ...base(tz), customerName: 'x' });
    const date = seriesDates(made.startDate!, {})[1];
    await svc.skipDate(owner, made.id, date);
    const list = bookings.filter((b) => b.recurringSeriesId);
    expect(list.filter((b) => b.status === 'cancelled')).toHaveLength(1);
    expect(list.filter((b) => b.status === 'confirmed')).toHaveLength(3);
    await svc.extendAll(); // must not resurrect it
    expect(bookings.filter((b) => b.recurringSeriesId && b.status === 'confirmed')).toHaveLength(3);
  });

  it('cancel-from ends the series and cancels that date onward', async () => {
    const { svc, bookings, series, tz } = setup();
    const made = await svc.create(owner, { ...base(tz, { weeks: 6 }), customerName: 'x' });
    const date = seriesDates(made.startDate!, {})[2];
    const out = await svc.cancelFrom(owner, made.id, date);
    expect(out.until).toBe(addDays(date, -7));
    expect(bookings.filter((b) => b.status === 'confirmed')).toHaveLength(2);
    expect(series[0].status).toBe('active');
  });

  it('reschedule moves later dates to the new hour and reports clashes in preview', async () => {
    const { svc, bookings, tz } = setup();
    const made = await svc.create(owner, { ...base(tz), customerName: 'x' });
    const from = seriesDates(made.startDate!, {})[1];
    const third = sessionWindow(seriesDates(made.startDate!, {})[2], '21:00', 60, tz).start;
    bookings.push({ id: 'y', courtId: 'c1', status: 'confirmed', slotStart: third, slotEnd: new Date(third.getTime() + 3_600_000) });

    const dry = await svc.reschedule(owner, made.id, { fromDate: from, startTime: '21:00', preview: true });
    expect(dry.conflicts).toEqual([seriesDates(made.startDate!, {})[2]]);
    expect(bookings.filter((b) => b.recurringSeriesId && b.status === 'confirmed')).toHaveLength(4); // untouched

    const out: any = await svc.reschedule(owner, made.id, { fromDate: from, startTime: '21:00' });
    expect(out.startTime).toBe('21:00');
    expect(out.conflicts).toHaveLength(1);
    const live = bookings.filter((b) => b.recurringSeriesId && b.status === 'confirmed');
    expect(live).toHaveLength(1 + 2); // first (old hour) + two new-hour sessions
  });

  it('the daily job extends the horizon without duplicating and tells the owner once', async () => {
    const { svc, bookings, series, notices, tz } = setup();
    await svc.create(owner, { ...base(tz, { weeks: 20 }), customerName: 'x' });
    const before = bookings.length;
    expect(before).toBe(8); // today+3 .. 8 weeks ahead
    const later = new Date(Date.now() + 14 * 86_400_000);
    // A clash appears on a date that is not booked yet.
    const target = sessionWindow(seriesDates(series[0].startDate, {})[9], '20:00', 60, tz).start;
    bookings.push({ id: 'z', courtId: 'c1', status: 'confirmed', slotStart: target, slotEnd: new Date(target.getTime() + 3_600_000) });
    const a = await svc.extendAll(later);
    expect(a.created).toBe(1); // index 8 books; 9 clashes
    expect(a.conflicts).toBe(1);
    expect(notices).toHaveLength(1);
    const b = await svc.extendAll(later);
    expect(b.created).toBe(0);
    expect(notices).toHaveLength(1); // deduped
  });

  it('keeps the same local hour across a daylight-saving change', async () => {
    const { svc, bookings } = setup({ tz: 'Europe/Berlin' });
    // Berlin leaves DST on the last Sunday of October; start the series the week before.
    const start = sessionWindow('2027-10-24', '20:00', 60, 'Europe/Berlin').start.toISOString();
    jest.useFakeTimers().setSystemTime(new Date('2027-10-20T10:00:00Z'));
    try {
      await svc.create(owner, { venueId: 'v1', courtId: 'c1', startsAt: start, durationMinutes: 60, weeks: 3, customerName: 'x' });
    } finally {
      jest.useRealTimers();
    }
    const hours = bookings.map((b) => b.slotStart.toISOString().slice(11, 16));
    expect(hours).toEqual(['18:00', '19:00', '19:00']); // 20:00 local both before and after the shift
  });

  it('admin can read but only writes in edit mode', async () => {
    const { svc, tz } = setup();
    await expect(svc.preview(admin, base(tz))).resolves.toBeTruthy();
    await expect(svc.create(admin, { ...base(tz), customerName: 'x' })).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'ADMIN_READ_ONLY' }),
    });
    await expect(svc.create({ ...admin, adminEdit: true } as any, { ...base(tz), customerName: 'x' })).resolves.toBeTruthy();
  });
});
