import { OwnerAssistantService } from './owner-assistant.service';
import type { AssistantReading } from './assistant.types';

const user = { id: 'u1', roles: ['owner'] } as never;
const DAY = 86_400_000;

const reading: AssistantReading = {
  intent: 'debts',
  courtIds: [],
  allCourts: false,
  date: new Date().toISOString().slice(0, 10),
  fromMins: null,
  toMins: null,
  durationMinutes: null,
  customerName: '',
  customerPhone: '',
  totalAmount: null,
  paidAmount: null,
  remainingAmount: null,
  paymentMethod: null,
  sourceKey: null,
  expenseCategory: null,
  rangeKey: null,
  reason: '',
  confidence: 0.95,
  newDate: null,
  newFromMins: null,
  newCourtId: null,
  question: '',
};

/** A manual booking row as Prisma returns it for `findOwed`. */
const booking = (id: string, name: string, startOffsetMs: number, total: number, paid = 0) => ({
  id,
  venueId: 'v1',
  code: `MAN-${id}`,
  guestName: name,
  court: { name: 'Pitch 1' },
  slotStart: new Date(Date.now() + startOffsetMs),
  slotEnd: new Date(Date.now() + startOffsetMs + 3_600_000),
  totalAmount: total,
  currency: 'AED',
  payments: paid ? [{ amount: paid }] : [],
});

function build(rows: ReturnType<typeof booking>[]) {
  const prisma = {
    venue: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'v1',
        ownerId: 'u1',
        nameAr: 'مارينا',
        nameEn: 'Marina',
        currency: 'AED',
        country: { timezone: 'Asia/Dubai' },
      }),
    },
    court: { findMany: jest.fn().mockResolvedValue([]) },
    booking: {
      // Same filter semantics as the database, so each call sees only what its window would match.
      findMany: jest.fn().mockImplementation(({ where }: { where: { slotEnd?: { lt: Date; gte?: Date }; slotStart?: { gte?: Date; lt?: Date } } }) =>
        Promise.resolve(
          rows.filter((b) => {
            if (where.slotEnd?.lt && !(b.slotEnd < where.slotEnd.lt)) return false;
            if (where.slotEnd?.gte && !(b.slotEnd >= where.slotEnd.gte)) return false;
            if (where.slotStart?.gte && !(b.slotStart >= where.slotStart.gte)) return false;
            if (where.slotStart?.lt && !(b.slotStart < where.slotStart.lt)) return false;
            return true;
          }),
        ),
      ),
    },
  };
  const nlu = { enabled: true, read: jest.fn().mockResolvedValue(reading) };
  const service = new OwnerAssistantService(prisma as never, nlu as never, {} as never, {} as never, {} as never);
  return { service };
}

describe('"who owes me?"', () => {
  it('lists an old debt instead of answering "nobody" (it only looked at the next 7 days)', async () => {
    const { service } = build([booking('1', 'Ali', -20 * DAY, 12_000)]);
    const plan = await service.ask(user, 'v1', 'مين عليه فلوس؟');
    expect(plan.intent).toBe('debts');
    expect(plan.reply.ar).not.toContain('محدش عليه فلوس');
    expect(plan.reply.ar).toContain('Ali');
    expect(plan.reply.ar).toContain('120');
    expect(plan.reply.ar).toContain('د.إ');
    expect(plan.bookings[0]).toMatchObject({ customerName: 'Ali', outstanding: 12_000, currency: 'AED' });
  });

  it('shows finished and upcoming balances side by side, and nets off partial payments', async () => {
    const { service } = build([
      booking('1', 'Ali', -3 * DAY, 10_000, 4_000),
      booking('2', 'Sara', 2 * DAY, 8_000),
    ]);
    const plan = await service.ask(user, 'v1', 'مين عليه فلوس؟');
    expect(plan.reply.en).toContain('finished bookings owe 60 AED');
    expect(plan.reply.en).toContain('upcoming bookings carry 80 AED');
    expect(plan.bookings.map((b) => b.customerName)).toEqual(['Ali', 'Sara']);
  });

  it('includes a game that is being played right now', async () => {
    const { service } = build([booking('1', 'Omar', -30 * 60_000, 9_000)]);
    const plan = await service.ask(user, 'v1', 'مين عليه فلوس؟');
    expect(plan.reply.ar).toContain('Omar');
  });

  it('only says everyone has paid when finished and upcoming bookings are both settled', async () => {
    const { service } = build([booking('1', 'Ali', -3 * DAY, 10_000, 10_000)]);
    const plan = await service.ask(user, 'v1', 'مين عليه فلوس؟');
    expect(plan.reply.ar).toContain('كله خالص');
  });
});
