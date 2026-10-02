import { OwnerAssistantExecutorService } from './owner-assistant-executor.service';
import { UNDO_KIND, UNDO_WINDOW_MS } from './assistant-undo';

const user = { id: 'u1', roles: ['owner'] } as never;

function build(opts: { row?: Record<string, unknown> | null; claim?: number } = {}) {
  const prisma = {
    venue: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'v1',
        ownerId: 'u1',
        currency: 'EGP',
      }),
    },
    payment: {
      findMany: jest.fn().mockResolvedValue([{ id: 'p0' }]),
      findFirst: jest.fn().mockResolvedValue({ id: 'p1' }),
    },
    booking: { findUnique: jest.fn() },
    assistantMessage: {
      create: jest.fn().mockResolvedValue({ id: 'undo-1' }),
      findUnique: jest.fn().mockResolvedValue(opts.row ?? null),
      updateMany: jest.fn().mockResolvedValue({ count: opts.claim ?? 1 }),
    },
  };
  const bookings = {
    createManualBooking: jest.fn().mockResolvedValue({ id: 'b1', code: 'M-1' }),
    addManualPayment: jest
      .fn()
      .mockResolvedValue({ id: 'b2', money: { outstanding: 0 } }),
    deleteManualBooking: jest.fn().mockResolvedValue({ id: 'b1' }),
    restoreManualBooking: jest.fn().mockResolvedValue({ id: 'b3' }),
    voidManualPayment: jest.fn().mockResolvedValue({ id: 'b2' }),
    updateManualBooking: jest.fn().mockResolvedValue({ id: 'b4' }),
  };
  const expenses = {
    create: jest.fn().mockResolvedValue({ id: 'e1' }),
    remove: jest.fn().mockResolvedValue({ ok: true }),
  };
  const service = new OwnerAssistantExecutorService(
    prisma as never,
    bookings as never,
    expenses as never,
  );
  return { service, prisma, bookings, expenses };
}

const record = (inverse: unknown[], ageMs = 1000) => ({
  id: 'undo-1',
  venueId: 'v1',
  ownerId: 'u1',
  consumedAt: null,
  createdAt: new Date(Date.now() - ageMs),
  appliedChange: { kind: UNDO_KIND, v: 1, inverse },
});

describe('assistant executor — recording the undo', () => {
  it('returns an undoId whose stored inverse cancels the booking it created', async () => {
    const { service, prisma } = build();
    const res = await service.execute(user, 'v1', [
      {
        kind: 'create_booking',
        courtId: 'c1',
        startsAt: new Date(Date.now() + 86_400_000).toISOString(),
        durationMinutes: 60,
        priceAmount: 300,
        paymentStatus: 'unpaid',
      },
    ]);
    expect(res.undoId).toBe('undo-1');
    const stored = prisma.assistantMessage.create.mock.calls[0][0].data;
    expect(stored.sender).toBe('system');
    expect(stored.appliedChange.inverse).toEqual([{ op: 'void_booking', bookingId: 'b1' }]);
  });

  it('captures the payment row it just added so Undo removes exactly that one', async () => {
    const { service, prisma } = build();
    await service.execute(user, 'v1', [
      { kind: 'record_payment', bookingId: 'b2', amount: 200 },
    ]);
    expect(prisma.payment.findFirst.mock.calls[0][0].where.id).toEqual({ notIn: ['p0'] });
    expect(prisma.assistantMessage.create.mock.calls[0][0].data.appliedChange.inverse).toEqual([
      { op: 'void_payment', bookingId: 'b2', paymentId: 'p1' },
    ]);
  });

  it('records what an edit replaced, from the row as it was', async () => {
    const { service, prisma } = build();
    prisma.booking.findUnique.mockResolvedValue({
      courtId: 'c1',
      slotStart: new Date('2030-01-01T18:00:00Z'),
      slotEnd: new Date('2030-01-01T20:00:00Z'),
      totalAmount: 400,
    });
    await service.execute(user, 'v1', [
      { kind: 'update_booking', bookingId: 'b4', durationMinutes: 60 },
    ]);
    expect(prisma.assistantMessage.create.mock.calls[0][0].data.appliedChange.inverse).toEqual([
      {
        op: 'revert_booking',
        bookingId: 'b4',
        courtId: 'c1',
        startsAt: '2030-01-01T18:00:00.000Z',
        durationMinutes: 120,
        priceAmount: 400,
      },
    ]);
  });

  it('a failed anchor write never turns a successful booking into an error', async () => {
    const { service, prisma } = build();
    prisma.assistantMessage.create.mockRejectedValue(new Error('db down'));
    const res = await service.execute(user, 'v1', [
      { kind: 'add_expense', venueId: 'v1', category: 'electricity', amount: 500, incurredOn: '2030-01-01' },
    ]);
    expect(res.ok).toBe(true);
    expect(res.undoId).toBeNull();
  });
});

describe('assistant executor — undo', () => {
  it('reverses in reverse order', async () => {
    const { service, bookings, expenses } = build({
      row: record([
        { op: 'void_booking', bookingId: 'b1' },
        { op: 'remove_expense', expenseId: 'e1' },
      ]),
    });
    const order: string[] = [];
    bookings.deleteManualBooking.mockImplementation(() => {
      order.push('booking');
      return Promise.resolve({});
    });
    expenses.remove.mockImplementation(() => {
      order.push('expense');
      return Promise.resolve({});
    });
    const res = await service.undo(user, 'v1', 'undo-1');
    expect(res.ok).toBe(true);
    expect(order).toEqual(['expense', 'booking']);
  });

  it('refuses a second use', async () => {
    const { service, bookings } = build({
      row: record([{ op: 'void_booking', bookingId: 'b1' }]),
      claim: 0,
    });
    await expect(service.undo(user, 'v1', 'undo-1')).rejects.toThrow('Already undone');
    expect(bookings.deleteManualBooking).not.toHaveBeenCalled();
  });

  it('refuses once the window has passed', async () => {
    const { service, bookings } = build({
      row: record([{ op: 'void_booking', bookingId: 'b1' }], UNDO_WINDOW_MS + 1000),
    });
    await expect(service.undo(user, 'v1', 'undo-1')).rejects.toThrow('window');
    expect(bookings.deleteManualBooking).not.toHaveBeenCalled();
  });

  it("refuses someone else's anchor and an ordinary chat row", async () => {
    const other = build({ row: { ...record([]), ownerId: 'someone-else' } });
    await expect(other.service.undo(user, 'v1', 'undo-1')).rejects.toThrow('Nothing to undo');
    const chat = build({
      row: { ...record([]), appliedChange: { remove: [], create: [] } },
    });
    await expect(chat.service.undo(user, 'v1', 'undo-1')).rejects.toThrow('Nothing to undo');
  });

  it('reports a step that could not be reversed instead of claiming success', async () => {
    const { service, bookings } = build({
      row: record([{ op: 'restore_booking', bookingId: 'b3' }]),
    });
    bookings.restoreManualBooking.mockRejectedValue(new Error('slot taken'));
    const res = await service.undo(user, 'v1', 'undo-1');
    expect(res.ok).toBe(false);
    expect(res.reply.en).toContain('Could not reverse');
  });
});
