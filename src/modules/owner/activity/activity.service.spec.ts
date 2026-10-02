import { ActivityService, describeActivity } from './activity.service';
import { bi } from '../assistant/assistant.types';

const who = bi('أحمد', 'Ahmed');
const say = (action: string, meta: Record<string, unknown>, currency = 'AED') => describeActivity(action, meta, currency).text(who);

describe('describeActivity — a decision in a sentence', () => {
  it('who booked, for whom, at what price, in the venue currency', () => {
    const t = say('owner.booking.created', { amount: 12_000, currency: 'AED', customer: 'Sara', code: 'MAN-1' });
    expect(t.ar).toBe('أحمد سجّل حجز لـ Sara بـ 120 د.إ (MAN-1)');
    expect(t.en).toBe('Ahmed booked for Sara at 120 AED (MAN-1)');
  });

  it('who changed a price, from what to what — and files it under price', () => {
    const d = describeActivity('owner.booking.updated', { changed: { priceAmount: [10_000, 8_000] }, currency: 'EGP' }, 'EGP');
    expect(d.kind).toBe('price');
    expect(d.text(who).en).toBe('Ahmed changed price from 100 EGP to 80 EGP');
    expect(d.text(who).ar).toBe('أحمد عدّل السعر من 100 ج.م إلى 80 ج.م');
  });

  it('who took money, how much was left, and who refunded and why', () => {
    expect(say('owner.booking.payment_recorded', { amount: 5_000, remaining: 3_000 }).en).toBe('Ahmed took 50 AED (30 AED left)');
    expect(say('owner.booking.payment_voided', { amount: 5_000, reason: 'double charge' }).en).toBe('Ahmed refunded 50 AED — double charge');
  });

  it('who took a drawer over and whether the count matched; who closed it and how it balanced', () => {
    expect(say('owner.shift.opened', { countedFloat: 15_000, difference: -5_000 }).en).toBe('Ahmed took the drawer over, counting 150 AED (50 AED less than left)');
    expect(say('owner.shift.opened', { countedFloat: 20_000, difference: 0 }).en).toBe('Ahmed took the drawer over, counting 200 AED');
    expect(say('owner.shift.closed', { difference: 0 }).en).toBe('Ahmed closed the drawer: it balanced');
    expect(say('owner.shift.closed', { difference: -1_000 }).en).toBe('Ahmed closed the drawer: 10 AED short');
  });

  it('never throws on an action it does not know', () => {
    expect(say('something.new', {}).en).toBe('Ahmed made a change');
  });
});

describe('ActivityService.list', () => {
  function build(rows: Array<Record<string, unknown>>) {
    const prisma = {
      venue: { findUnique: jest.fn().mockResolvedValue({ id: 'v1', ownerId: 'o1', currency: 'AED' }) },
      auditLogEntry: { findMany: jest.fn().mockResolvedValue(rows) },
      user: { findMany: jest.fn().mockResolvedValue([{ id: 'u1', name: 'Ahmed' }]) },
    };
    return { service: new ActivityService(prisma as never), prisma };
  }

  it('reads this venue\'s decisions newest first, names the actor and links the booking', async () => {
    const { service, prisma } = build([
      { id: 'a2', actorUserId: 'u1', action: 'owner.booking.cancelled', createdAt: new Date('2026-10-03T10:00:00Z'), metadata: { bookingId: 'b1', venueId: 'v1', code: 'MAN-9', amount: 9_000, currency: 'AED' } },
      { id: 'a1', actorUserId: 'u1', action: 'owner.shift.closed', createdAt: new Date('2026-10-03T09:00:00Z'), metadata: { venueId: 'v1', difference: 0 } },
    ]);
    const out = await service.list({ id: 'o1', roles: ['owner'] } as never, 'v1');
    expect(out.items[0]).toMatchObject({ id: 'a2', kind: 'booking', actorName: 'Ahmed', bookingId: 'b1' });
    expect(out.items[0].text.en).toBe('Ahmed cancelled booking MAN-9');
    const where = prisma.auditLogEntry.findMany.mock.calls[0][0].where;
    expect(where.OR).toContainEqual({ metadata: { path: ['venueId'], equals: 'v1' } });
    expect(where.OR).toContainEqual({ targetType: 'venue', targetId: 'v1' });
  });

  it('pages with a cursor', async () => {
    const rows = Array.from({ length: 41 }, (_, i) => ({ id: `a${i}`, actorUserId: 'u1', action: 'owner.shift.closed', createdAt: new Date(), metadata: { venueId: 'v1', difference: 0 } }));
    const { service } = build(rows);
    const out = await service.list({ id: 'o1', roles: ['owner'] } as never, 'v1');
    expect(out.items).toHaveLength(40);
    expect(out.nextCursor).toBe('a39');
  });
});
