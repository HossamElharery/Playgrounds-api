import { OwnerAssistantService } from './owner-assistant.service';
import type { AssistantReading } from './assistant.types';

const user = { id: 'u1', roles: ['owner'] } as never;
const future = () => {
  const d = new Date(Date.now() + 2 * 86_400_000);
  return d.toISOString().slice(0, 10);
};

const reading = (over: Partial<AssistantReading>): AssistantReading => ({
  intent: 'book',
  courtIds: ['c1'],
  allCourts: false,
  date: future(),
  fromMins: 840,
  toMins: null,
  durationMinutes: 60,
  customerName: 'أحمد',
  customerPhone: '',
  totalAmount: 300,
  paidAmount: null,
  remainingAmount: null,
  paymentMethod: null,
  sourceKey: null,
  expenseCategory: null,
  rangeKey: null,
  reason: '',
  confidence: 0.9,
  newDate: null,
  newFromMins: null,
  newCourtId: null,
  question: '',
  ...over,
});

function build(conflict: 'SLOT_BLOCKED' | 'SLOT_ALREADY_HELD' | null, read: AssistantReading) {
  const courts = [
    { id: 'c1', name: 'PS5 Room 1', pricingRules: [], slotDurationMins: 60, format: null, gamingConfig: null, tableConfig: null, sport: null },
    { id: 'c2', name: 'PS5 Room 2', pricingRules: [], slotDurationMins: 60, format: null, gamingConfig: null, tableConfig: null, sport: null },
  ];
  const prisma = {
    venue: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'v1',
        ownerId: 'u1',
        nameAr: 'نيون',
        nameEn: 'Neon',
        priceFromCurrency: 'EGP',
        country: { timezone: 'Africa/Cairo' },
      }),
    },
    court: { findMany: jest.fn().mockResolvedValue(courts) },
    booking: { findMany: jest.fn().mockResolvedValue([]) },
    calendarBlock: {
      findMany: jest.fn().mockResolvedValue([{ note: 'صيانة', kind: 'maintenance' }]),
    },
  };
  const bookings = {
    // Only the requested court/time is taken; the other room is free.
    slotConflict: jest.fn().mockImplementation((_db, courtId: string) =>
      Promise.resolve(courtId === 'c1' ? conflict : null),
    ),
  };
  const nlu = { enabled: true, read: jest.fn().mockResolvedValue(read) };
  const service = new OwnerAssistantService(
    prisma as never,
    nlu as never,
    bookings as never,
    {} as never,
    {} as never,
  );
  return { service, prisma };
}

describe('assistant guards', () => {
  it('asks before booking over a window the owner closed', async () => {
    const { service } = build('SLOT_BLOCKED', reading({}));
    const plan = await service.ask(user, 'v1', 'أحمد هيحجز بكرة 2');
    expect(plan.needsConfirm).toBe(true);
    expect(plan.issues.map((i) => i.code)).toContain('BLOCK_OVERRIDE');
    expect(plan.reply.ar).toContain('قافله');
    expect(plan.reply.ar).toContain('صيانة');
    expect(plan.actions[0]).toMatchObject({ kind: 'create_booking', overrideBlocks: true });
  });

  it('offers the free room instead of a bare refusal when the slot is taken', async () => {
    const { service } = build('SLOT_ALREADY_HELD', reading({}));
    const plan = await service.ask(user, 'v1', 'احجز غرفة 1 بكرة 2');
    expect(plan.actions).toHaveLength(0);
    expect(plan.reply.ar).toContain('PS5 Room 2');
    expect(plan.draft).toBeTruthy();
  });

  it('warns when the same customer already has a booking that day', async () => {
    const { service, prisma } = build(null, reading({}));
    // Only the same-day lookup (it filters on guestName) finds the other booking.
    prisma.booking.findMany.mockImplementation((args: { where: { guestName?: unknown } }) =>
      Promise.resolve(
        args.where.guestName
          ? [{ guestName: 'أحمد', court: { name: 'PS5 Room 2' }, slotStart: new Date(Date.now() + 86_400_000 * 2) }]
          : [],
      ),
    );
    const plan = await service.ask(user, 'v1', 'احجز لأحمد');
    expect(plan.issues.map((i) => i.code)).toContain('DUPLICATE_CUSTOMER');
    expect(plan.needsConfirm).toBe(true);
  });
});
