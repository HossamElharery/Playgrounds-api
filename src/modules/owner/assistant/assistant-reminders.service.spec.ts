import { AssistantRemindersService, debtFingerprint, localHour } from './assistant-reminders.service';

const NOW = new Date('2026-10-03T09:00:00.000Z');
const HOUR = 3_600_000;

const row = (id: string, total: number, hoursAgo = 48) => ({
  id,
  venueId: 'v1',
  code: `MAN-${id}`,
  guestName: `Guest ${id}`,
  court: { name: 'Pitch 1' },
  slotStart: new Date(NOW.getTime() - (hoursAgo + 1) * HOUR),
  slotEnd: new Date(NOW.getTime() - hoursAgo * HOUR),
  totalAmount: total,
  currency: 'AED',
  payments: [],
});

function build(bookings: ReturnType<typeof row>[], sent: Array<{ userId?:string; payload: Record<string, unknown>; createdAt: Date }> = [], staff: Array<{userId:string;permissions:string[]}> = []) {
  const prisma = {
    staffMember: { findMany: jest.fn().mockResolvedValue(staff) },
    booking: { findMany: jest.fn().mockResolvedValue(bookings) },
    venue: { findUnique: jest.fn().mockResolvedValue({ ownerId: 'o1', nameAr: 'مارينا', nameEn: 'Marina', country: { timezone: 'Asia/Dubai' } }) },
    notification: {
      // Answers "was a notification with this kind/key/value created inside the window?" from `sent`.
      findFirst: jest.fn().mockImplementation(({ where }: { where: { userId: string; createdAt: { gte: Date }; AND: Array<{ payload: { path: string[]; equals: string } }> } }) => {
        const hit = sent.find(
          (n) => (n.userId ?? 'o1') === where.userId && n.createdAt >= where.createdAt.gte && where.AND.every((c) => n.payload[c.payload.path[0]] === c.payload.equals),
        );
        return Promise.resolve(hit ? { id: 'n' } : null);
      }),
    },
  };
  const notifications = {
    create: jest.fn().mockImplementation(async (n: { userId:string; payload: Record<string, unknown> }) => {
      sent.push({ userId:n.userId, payload: n.payload, createdAt: NOW });
      return {};
    }),
  };
  return { service: new AssistantRemindersService(prisma as never, notifications as never), notifications, sent, prisma };
}

describe('AssistantRemindersService — unpaid digest', () => {
  it('does not send debt totals to bookings-only staff', async () => {
    const {service,notifications}=build([row('1',12000)],[],[{userId:'booker',permissions:['bookings.view']},{userId:'cashier',permissions:['bookings.view','payments.record']}]);
    expect(await service.sendOverdue(NOW)).toBe(2);
    expect(notifications.create.mock.calls.map(c=>c[0].userId)).toEqual(['o1','cashier']);
  });

  it('sends one digest that opens THIS venue, with the venue currency', async () => {
    const { service, notifications } = build([row('1', 12_000)]);
    await expect(service.sendOverdue(NOW)).resolves.toBe(1);
    const call = notifications.create.mock.calls[0][0];
    expect(call.deepLink).toBe('/owner/today?venue=v1');
    expect(call.titleAr).toContain('د.إ');
    expect(call.payload.fingerprint).toBe(debtFingerprint([{ id: '1', outstanding: 12_000 }]));
  });

  it('does not announce the same unpaid bookings again the next morning', async () => {
    const { service, notifications, sent } = build([row('1', 12_000)]);
    await service.sendOverdue(NOW);
    // Next day, same debt: the 10-hour venue window has passed but nothing changed.
    sent[0].createdAt = new Date(NOW.getTime() - 24 * HOUR);
    await expect(service.sendOverdue(NOW)).resolves.toBe(0);
    expect(notifications.create).toHaveBeenCalledTimes(1);
  });

  it('speaks up again when the debt changes (a new one appears)', async () => {
    const { service, sent } = build([row('1', 12_000), row('2', 5_000)]);
    sent.push({ payload: { kind: 'assistant_overdue', venueId: 'v1', fingerprint: debtFingerprint([{ id: '1', outstanding: 12_000 }]) }, createdAt: new Date(NOW.getTime() - 24 * HOUR) });
    await expect(service.sendOverdue(NOW)).resolves.toBe(1);
  });

  it('reminds again after three quiet days', async () => {
    const { service, sent } = build([row('1', 12_000)]);
    sent.push({ payload: { kind: 'assistant_overdue', venueId: 'v1', fingerprint: debtFingerprint([{ id: '1', outstanding: 12_000 }]) }, createdAt: new Date(NOW.getTime() - 80 * HOUR) });
    await expect(service.sendOverdue(NOW)).resolves.toBe(1);
  });
});

describe('AssistantRemindersService — the digest follows each venue\'s own clock', () => {
  const HOURS = { localHours: [11, 20] as const };

  it('reads the hour on the venue clock, not the server\'s', () => {
    expect(localHour(new Date('2026-10-03T07:00:00Z'), 'Asia/Dubai')).toBe(11);
    expect(localHour(new Date('2026-10-03T07:00:00Z'), 'Africa/Cairo')).toBe(10);
  });

  it('stays quiet when it is not 11:00 or 20:00 where the venue is', async () => {
    const { service, notifications } = build([row('1', 12_000)]);
    // 09:00Z is 13:00 in Dubai — neither moment.
    await expect(service.sendOverdue(NOW, HOURS)).resolves.toBe(0);
    expect(notifications.create).not.toHaveBeenCalled();
  });

  it('sends at 11:00 and at 20:00 local time (Dubai: 07:00Z and 16:00Z)', async () => {
    const morning = build([row('1', 12_000)]);
    await expect(morning.service.sendOverdue(new Date('2026-10-03T07:00:00Z'), HOURS)).resolves.toBe(1);
    const evening = build([row('1', 12_000)]);
    await expect(evening.service.sendOverdue(new Date('2026-10-03T16:00:00Z'), HOURS)).resolves.toBe(1);
  });
});

describe('AssistantRemindersService — arrival with a balance', () => {
  it('sends an operational arrival to bookings staff and money only to authorised recipients', async () => {
    const soon = { ...row('9', 8000, 0), slotStart:new Date(NOW.getTime()+45*60000),slotEnd:new Date(NOW.getTime()+105*60000) };
    const {service,notifications}=build([soon],[],[{userId:'booker',permissions:['bookings.view']},{userId:'cashier',permissions:['bookings.view','payments.record']}]);
    expect(await service.sendArrivals(NOW)).toBe(3);
    const calls=notifications.create.mock.calls.map(c=>c[0]);
    const booker=calls.find(c=>c.userId==='booker');
    expect(booker.titleAr).not.toContain('عليه');
    expect(booker.payload).not.toHaveProperty('currency');
    expect(booker.payload.kind).toBe('assistant_arrival');
    expect(calls.find(c=>c.userId==='cashier').titleAr).toContain('د.إ');
    expect(await service.sendArrivals(NOW)).toBe(0);
  });

  it('links straight to the booking in the right venue', async () => {
    const soon = { ...row('9', 8_000, 0), slotStart: new Date(NOW.getTime() + 45 * 60_000), slotEnd: new Date(NOW.getTime() + 105 * 60_000) };
    const { service, notifications } = build([soon]);
    await expect(service.sendArrivals(NOW)).resolves.toBe(1);
    expect(notifications.create.mock.calls[0][0].deepLink).toBe('/owner/today?venue=v1&booking=9');
  });
});


describe('settled arrivals and refunded balances', () => {
  it('reminds the owner and booking staff about a fully paid arrival without asking for money', async () => {
    const paid = { ...row('paid', 12000, -1), payments: [{ amount: 12000 }] };
    const { service, notifications, prisma } = build([paid as ReturnType<typeof row>], [], [{ userId: 'booker', permissions: ['bookings.view'] }]);
    expect(await service.sendArrivals(NOW)).toBe(2);
    expect(prisma.booking.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.not.objectContaining({ paymentStatus: expect.anything() }) }));
    for (const [notice] of notifications.create.mock.calls) {
      expect(notice.payload.kind).toBe('assistant_arrival');
      expect(notice.titleAr).not.toContain('عليه');
      expect(notice.bodyAr).not.toContain('حصّل');
    }
    expect(await service.sendArrivals(NOW)).toBe(0);
  });

  it('subtracts refunded rows when computing the debt reminder', async () => {
    const refunded = { ...row('refunded', 12000), payments: [{ amount: 12000 }, { amount: -5000 }] };
    const { service, notifications, prisma } = build([refunded as ReturnType<typeof row>]);
    expect(await service.sendOverdue(NOW)).toBe(1);
    expect(notifications.create.mock.calls[0][0].payload.total).toBe(5000);
    expect(prisma.booking.findMany).toHaveBeenCalledWith(expect.objectContaining({ include: expect.objectContaining({ payments: expect.objectContaining({ where: { status: { in: ['paid', 'refunded'] } } }) }) }));
  });
});
