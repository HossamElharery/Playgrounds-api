import { OwnerAssistantService } from './owner-assistant.service';

const user = { id: 'u1', roles: ['owner'], name: 'Owner' } as never;
const now = Date.now();
const booking = {
  id: 'b1', venueId: 'v1', code: 'MAN-1', guestName: 'محمد', status: 'confirmed',
  checkedInAt: null, court: { name: 'Court 1' },
  slotStart: new Date(now + 30 * 60_000), slotEnd: new Date(now + 90 * 60_000),
  totalAmount: 40000, currency: 'EGP', payments: [{ amount: 20000 }],
};

function build() {
  const prisma = {
    venue: { findUnique: jest.fn().mockResolvedValue({ id: 'v1', ownerId: 'u1', nameAr: 'نادي المعادي', nameEn: 'Maadi Club', currency: 'EGP', country: { timezone: 'Africa/Cairo' } }) },
    booking: {
      findFirst: jest.fn().mockResolvedValue(booking),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
  };
  const nlu = { enabled: true, read: jest.fn() };
  const summary = {
    cashToday: jest.fn().mockResolvedValue({ byMethod: [{ method: 'cash', amount: 120000, count: 4 }], received: 150000, advance: 30000, late: 10000, refunds: 5000 }),
    getSummary: jest.fn().mockResolvedValue({
      totals: { bookings: 6, collectedRevenue: 240000 },
      byUnit: [{ name: 'Court 1', occupancyPct: 75 }, { name: 'Court 2', occupancyPct: 40 }],
      quietHours: [{ hour: 13 }, { hour: 14 }],
    }),
  };
  const service = new OwnerAssistantService(prisma as never, nlu as never, {} as never, summary as never, {} as never);
  return { service, prisma, nlu, summary };
}

describe('owner assistant operational shortcuts', () => {
  it('answers the next-booking question without spending an AI call', async () => {
    const { service, nlu } = build();
    const plan = await service.ask(user, 'v1', 'الحجز اللي بعده مين؟');
    expect(plan.intent).toBe('next_booking');
    expect(plan.reply.ar).toContain('محمد');
    expect(plan.reply.ar).toContain('باقي عليه');
    expect(nlu.read).not.toHaveBeenCalled();
  });

  it('keeps core operational reads working when the language model is disabled', async () => {
    const { service, nlu } = build();
    nlu.enabled = false;
    const plan = await service.ask(user, 'v1', 'الحجز اللي بعده مين؟');
    expect(plan.available).toBe(true);
    expect(plan.intent).toBe('next_booking');
    expect(plan.reply.ar).toContain('محمد');
  });

  it('answers late arrivals with a short operational result', async () => {
    const { service, prisma } = build();
    prisma.booking.findMany.mockResolvedValueOnce([{ ...booking, slotStart: new Date(now - 45 * 60_000) }]);
    const plan = await service.ask(user, 'v1', 'مين لسه موصلش؟');
    expect(plan.intent).toBe('late_arrivals');
    expect(plan.reply.ar).toContain('متأخر');
    expect(plan.bookings).toHaveLength(1);
  });

  it('separates drawer cash from revenue and refuses to invent a physical count', async () => {
    const { service } = build();
    const plan = await service.ask(user, 'v1', 'المفروض في الدرج كام؟');
    expect(plan.intent).toBe('cash_drawer');
    expect(plan.reply.ar).toContain('كاش');
    expect(plan.reply.ar).toContain('مش هخمن');
  });

  it('reports occupancy and quiet hours directly', async () => {
    const { service } = build();
    const plan = await service.ask(user, 'v1', 'أنهي ملعب شغال أكتر؟');
    expect(plan.intent).toBe('occupancy');
    expect(plan.reply.ar).toContain('Court 1');
    expect(plan.reply.ar).toContain('75%');
    expect(plan.reply.ar).toContain('13:00');
  });
});
