import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { OwnerBookingsService } from './owner-bookings.service';
import { ApiException } from '../../common/errors/api-exception';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.interface';
import { desiredLedgerDelta } from '../../common/money/booking-money';

const owner: AuthenticatedUser = {
  id: 'owner-1',
  phone: '+201000000001',
  name: 'Owner',
  roles: ['owner'],
};

const venue = {
  id: 'v1',
  ownerId: 'owner-1',
  weeklyHours: null,
  priceFromCurrency: 'EGP',
  paymentMode: 'at_venue',
};

const court = {
  id: 'c1',
  venueId: 'v1',
  name: 'Court 1',
  slotDurationMins: 60,
  sport: { activityKind: 'padel' },
};

function bookingRow(over: Record<string, unknown> = {}) {
  const slotStart = new Date('2026-09-20T18:00:00.000Z');
  return {
    id: 'b1',
    code: 'MAN-ABC',
    venueId: 'v1',
    courtId: 'c1',
    userId: 'owner-1',
    slotStart,
    slotEnd: new Date(slotStart.getTime() + 60 * 60_000),
    baseAmount: 400,
    feeAmount: 0,
    discountAmount: 0,
    totalAmount: 400,
    currency: 'EGP',
    status: 'confirmed',
    paymentStatus: 'paid',
    paymentMethod: 'cash',
    source: 'manual',
    sourceKey: 'walk_in',
    sourceLabel: null,
    guestName: 'Ahmed',
    guestPhone: '+201111',
    notes: null,
    checkedInAt: null,
    commissionAmount: null,
    ownerNetAmount: null,
    court: { name: 'Court 1', sport: { activityKind: 'padel' } },
    user: { id: 'owner-1', name: 'Owner', phone: '+201000000001' },
    payments: [{ amount: 400 }],
    ...over,
  };
}

function makePrisma(opts: { overlap?: boolean; booking?: ReturnType<typeof bookingRow> } = {}) {
  const created = bookingRow();
  const tx = {
    booking: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(opts.overlap ? { id: 'other' } : null),
      create: jest.fn().mockResolvedValue(created),
      update: jest.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
        ...created,
        ...data,
      })),
    },
    payment: {
      create: jest.fn().mockResolvedValue({}),
      aggregate: jest.fn().mockResolvedValue({ _sum: { amount: 0 } }),
    },
    calendarBlock: { findFirst: jest.fn().mockResolvedValue(null) },
    venueBookingSource: { upsert: jest.fn().mockResolvedValue({}) },
    auditLogEntry: { create: jest.fn().mockResolvedValue({}) },
  };
  return {
    tx,
    prisma: {
      venue: { findUnique: jest.fn().mockResolvedValue(venue) },
      court: { findUnique: jest.fn().mockResolvedValue(court) },
      booking: {
        findUnique: jest.fn().mockResolvedValue(opts.booking ?? created),
        findUniqueOrThrow: jest.fn().mockResolvedValue(opts.booking ?? created),
        findFirst: jest.fn(),
        aggregate: jest.fn().mockResolvedValue({ _sum: { amount: 0 } }),
      },
      payment: { aggregate: jest.fn().mockResolvedValue({ _sum: { amount: 0 } }) },
      venueBookingSource: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn(),
        delete: jest.fn(),
      },
      $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    },
  };
}

describe('OwnerBookingsService', () => {
  const ledger = { syncBookingLedger: jest.fn().mockResolvedValue({ wrote: false, delta: 0, desired: 0 }) };
  const commission = { resolveSource: jest.fn().mockResolvedValue({ bps: 1000, source: 'global' }) };

  function service(prisma: object) {
    return new OwnerBookingsService(prisma as never, ledger as never, commission as never, {
      create: jest.fn().mockResolvedValue(null),
    } as never);
  }

  // The fixtures live on 2026-09-20; pin "now" just before them.
  const NOW = new Date('2026-09-20T10:00:00.000Z').getTime();
  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
  });
  afterEach(() => jest.restoreAllMocks());

  const dto = {
    venueId: 'v1',
    courtId: 'c1',
    startsAt: '2026-09-20T18:00:00.000Z',
    durationMinutes: 60,
    priceAmount: 400,
    paymentStatus: 'paid' as const,
    paymentMethod: 'cash' as const,
  };

  it('creates a manual booking with no commission snapshot', async () => {
    const { prisma, tx } = makePrisma();
    const result = await service(prisma).createManualBooking(owner, dto);
    expect(tx.booking.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          source: 'manual',
          feeAmount: 0,
          baseAmount: 400,
          totalAmount: 400,
          userId: 'owner-1',
        }),
      }),
    );
    const createData = tx.booking.create.mock.calls[0][0].data;
    expect(createData.commissionAmount).toBeUndefined();
    expect(createData.commissionBps).toBeUndefined();
    expect(ledger.syncBookingLedger).toHaveBeenCalled();
    expect(result.money.commissionAmount).toBeUndefined();
    expect(desiredLedgerDelta({
      source: 'manual',
      paymentMode: 'at_venue',
      status: 'confirmed',
      paymentStatus: 'paid',
      checkedInAt: null,
      money: { ownerNet: 360, total: 400 },
    })).toBe(0);
  });

  it('rejects overlapping slots', async () => {
    const { prisma } = makePrisma({ overlap: true });
    await expect(service(prisma).createManualBooking(owner, dto)).rejects.toBeInstanceOf(ConflictException);
  });

  it('maps a serialization conflict to SLOT_ALREADY_HELD (concurrency)', async () => {
    const { prisma } = makePrisma();
    prisma.$transaction = jest.fn().mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('conflict', {
        code: 'P2034',
        clientVersion: '6.19.0',
      }),
    );
    try {
      await service(prisma).createManualBooking(owner, dto);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ConflictException);
      expect((err as ConflictException).getResponse()).toEqual(
        expect.objectContaining({ code: 'SLOT_ALREADY_HELD' }),
      );
    }
  });

  it('two creates for the same slot: the second sees the overlap', async () => {
    const { prisma, tx } = makePrisma();
    let occupied = false;
    tx.booking.findFirst.mockImplementation(async () => (occupied ? { id: 'first' } : null));
    tx.booking.create.mockImplementation(async () => {
      occupied = true;
      return bookingRow();
    });
    const svc = service(prisma);
    await svc.createManualBooking(owner, dto);
    await expect(svc.createManualBooking(owner, dto)).rejects.toBeInstanceOf(ConflictException);
  });

  it.each([
    'courtId',
    'startsAt',
    'durationMinutes',
    'priceAmount',
    'paymentStatus',
    'paymentMethod',
    'customerName',
    'customerPhone',
    'notes',
    'sourceKey',
    'sourceLabel',
  ] as const)('rejects platform field edit %s with PLATFORM_BOOKING_LOCKED', async (field) => {
    const platform = bookingRow({ source: 'platform', id: 'p1' });
    const { prisma } = makePrisma({ booking: platform });
    prisma.booking.findUnique.mockResolvedValue(platform);
    const patch: Record<string, unknown> = {
      courtId: 'c2',
      startsAt: '2026-09-20T19:00:00.000Z',
      durationMinutes: 90,
      priceAmount: 500,
      paymentStatus: 'unpaid',
      paymentMethod: 'card',
      customerName: 'X',
      customerPhone: '+2012',
      notes: 'n',
      sourceKey: 'phone',
      sourceLabel: 'Playtomic',
    };
    try {
      await service(prisma).updateManualBooking(owner, 'p1', { [field]: patch[field] });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiException);
      expect((err as ApiException).getResponse()).toEqual(
        expect.objectContaining({ code: 'PLATFORM_BOOKING_LOCKED' }),
      );
    }
  });

  it('soft-deletes manual bookings and blocks platform deletes', async () => {
    const { prisma, tx } = makePrisma();
    await service(prisma).deleteManualBooking(owner, 'b1');
    expect(tx.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'cancelled', cancellationReason: 'deleted_by_owner' }),
      }),
    );
    const platform = bookingRow({ source: 'platform' });
    prisma.booking.findUnique.mockResolvedValue(platform);
    await expect(service(prisma).deleteManualBooking(owner, 'p1')).rejects.toBeInstanceOf(ApiException);
  });

  it('restores a cancelled manual booking when the slot is free', async () => {
    const cancelled = bookingRow({ status: 'cancelled' });
    const { prisma } = makePrisma({ booking: cancelled });
    prisma.booking.findUnique.mockResolvedValue(cancelled);
    await service(prisma).restoreManualBooking(owner, 'b1');
    expect(prisma.$transaction).toHaveBeenCalled();
  });

  it('refuses overpayment on a later manual payment', async () => {
    const { prisma, tx } = makePrisma();
    tx.payment.aggregate.mockResolvedValue({ _sum: { amount: 400 } });
    try {
      await service(prisma).addManualPayment(owner, 'b1', 50, 'cash');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiException);
      expect((err as ApiException).getResponse()).toEqual(
        expect.objectContaining({ code: 'OVERPAYMENT' }),
      );
    }
  });

  const codeOf = (err: unknown) => (err as ApiException).getResponse() as { code?: string };

  it('refuses a booking that starts in the past', async () => {
    const { prisma } = makePrisma();
    await expect(
      service(prisma).createManualBooking(owner, { ...dto, startsAt: '2026-09-20T08:00:00.000Z' }),
    ).rejects.toMatchObject({ response: expect.objectContaining({ code: 'SLOT_IN_PAST' }) });
  });

  it('accepts a walk-in that starts right now (within the grace window)', async () => {
    const { prisma } = makePrisma();
    await expect(
      service(prisma).createManualBooking(owner, { ...dto, startsAt: '2026-09-20T09:50:00.000Z' }),
    ).resolves.toBeDefined();
  });

  it('refuses to move a booking into the past but lets an old one take a payment edit', async () => {
    const old = bookingRow({
      slotStart: new Date('2026-09-20T07:00:00.000Z'),
      slotEnd: new Date('2026-09-20T08:00:00.000Z'),
    });
    const { prisma } = makePrisma({ booking: old });
    prisma.booking.findUnique.mockResolvedValue(old);
    await expect(
      service(prisma).updateManualBooking(owner, 'b1', { startsAt: '2026-09-20T06:00:00.000Z' }),
    ).rejects.toMatchObject({ response: expect.objectContaining({ code: 'SLOT_IN_PAST' }) });
    await expect(
      service(prisma).updateManualBooking(owner, 'b1', { notes: 'late note' }),
    ).resolves.toBeDefined();
  });

  it('refuses to restore a booking whose slot is over', async () => {
    const gone = bookingRow({
      status: 'cancelled',
      slotStart: new Date('2026-09-20T07:00:00.000Z'),
      slotEnd: new Date('2026-09-20T08:00:00.000Z'),
    });
    const { prisma } = makePrisma({ booking: gone });
    prisma.booking.findUnique.mockResolvedValue(gone);
    await expect(service(prisma).restoreManualBooking(owner, 'b1')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'SLOT_IN_PAST' }),
    });
  });

  it('a partial payment leaves the booking partial with the remainder outstanding, then completes it', async () => {
    const booking = bookingRow({ paymentStatus: 'pending', payments: [] });
    const { prisma, tx } = makePrisma({ booking });
    prisma.booking.findUnique.mockResolvedValue(booking);
    tx.payment.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
    await service(prisma).addManualPayment(owner, 'b1', 150, 'cash');
    expect(tx.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ paymentStatus: 'partial' }) }),
    );
    tx.payment.aggregate.mockResolvedValue({ _sum: { amount: 150 } });
    await service(prisma).addManualPayment(owner, 'b1', 250, 'instapay');
    expect(tx.booking.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ paymentStatus: 'paid' }) }),
    );
  });

  it('never lets the price fall below what was already paid', async () => {
    const booking = bookingRow({ paymentStatus: 'partial' });
    const { prisma, tx } = makePrisma({ booking });
    prisma.booking.findUnique.mockResolvedValue(booking);
    tx.payment.aggregate.mockResolvedValue({ _sum: { amount: 300 } });
    await expect(
      service(prisma).updateManualBooking(owner, 'b1', { priceAmount: 200 }),
    ).rejects.toMatchObject({ response: expect.objectContaining({ code: 'PRICE_BELOW_PAID' }) });
  });

  it('re-derives the payment status from real payments when the price changes', async () => {
    const booking = bookingRow({ paymentStatus: 'paid' });
    const { prisma, tx } = makePrisma({ booking });
    prisma.booking.findUnique.mockResolvedValue(booking);
    tx.payment.aggregate.mockResolvedValue({ _sum: { amount: 400 } });
    await service(prisma).updateManualBooking(owner, 'b1', { priceAmount: 500 });
    expect(tx.booking.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ paymentStatus: 'partial' }) }),
    );
  });

  describe('Matchena bookings are locked; the venue asks the admin', () => {
    const platform = bookingRow({ source: 'platform', status: 'confirmed' });

    function withAdmin() {
      const { prisma } = makePrisma({ booking: platform });
      prisma.booking.findUnique.mockResolvedValue(platform);
      const extra = prisma as Record<string, unknown>;
      extra.auditLogEntry = { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({}) };
      extra.user = { findMany: jest.fn().mockResolvedValue([{ id: 'admin-1', email: 'admin@matchena.com' }]) };
      prisma.venue.findUnique.mockResolvedValue({ ...venue, nameEn: 'Arena', nameAr: 'الساحة', country: { timezone: 'Africa/Cairo' } });
      const notifications = { create: jest.fn().mockResolvedValue(null) };
      const email = { sendFinanceNotice: jest.fn().mockResolvedValue(undefined) };
      const svc = new OwnerBookingsService(prisma as never, ledger as never, commission as never, notifications as never, email as never);
      return { svc, extra, notifications, email };
    }

    it('cannot be edited, deleted, restored or paid by the owner', async () => {
      const { prisma } = makePrisma({ booking: platform });
      prisma.booking.findUnique.mockResolvedValue(platform);
      const svc = service(prisma);
      for (const call of [
        () => svc.updateManualBooking(owner, 'p1', { notes: 'x' }),
        () => svc.deleteManualBooking(owner, 'p1'),
        () => svc.restoreManualBooking(owner, 'p1'),
        () => svc.addManualPayment(owner, 'p1', 10, 'cash'),
      ]) {
        await expect(call()).rejects.toMatchObject({ response: expect.objectContaining({ code: 'PLATFORM_BOOKING_LOCKED' }) });
      }
    });

    it('a change request notifies + emails every admin and leaves the booking alone', async () => {
      const { svc, extra, notifications, email } = withAdmin();
      const res = await svc.requestPlatformChange(owner, 'p1', { kind: 'cancel', reason: 'Pitch flooded' });
      expect(res).toEqual({ ok: true, duplicate: false });
      expect(notifications.create).toHaveBeenCalledWith(expect.objectContaining({ userId: 'admin-1', deepLink: '/admin/bookings' }));
      expect(email.sendFinanceNotice).toHaveBeenCalledWith('admin@matchena.com', expect.stringContaining('cancel'), expect.stringContaining('Pitch flooded'));
      expect((extra.auditLogEntry as { create: jest.Mock }).create).toHaveBeenCalled();
    });

    it('needs a real reason and de-duplicates repeat taps', async () => {
      const { svc, extra } = withAdmin();
      await expect(svc.requestPlatformChange(owner, 'p1', { kind: 'change', reason: 'no' })).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'REASON_REQUIRED' }),
      });
      (extra.auditLogEntry as { findFirst: jest.Mock }).findFirst.mockResolvedValue({ id: 'a' });
      await expect(svc.requestPlatformChange(owner, 'p1', { kind: 'change', reason: 'Move to 20:00' })).resolves.toEqual({ ok: true, duplicate: true });
    });

    it('manual bookings do not go through the admin-request route', async () => {
      const manual = bookingRow();
      const { prisma } = makePrisma({ booking: manual });
      prisma.booking.findUnique.mockResolvedValue(manual);
      await expect(service(prisma).requestPlatformChange(owner, 'b1', { kind: 'cancel', reason: 'whatever' })).rejects.toBeDefined();
    });
  });
});

describe('Venue cancel of a Matchena booking', () => {
  it('BookingsService.ownerCancel refuses platform bookings with PLATFORM_BOOKING_LOCKED', async () => {
    const { BookingsService } = await import('../bookings/bookings.service');
    const svc = Object.create(BookingsService.prototype) as InstanceType<typeof BookingsService>;
    (svc as unknown as { prisma: unknown }).prisma = {
      booking: { findUnique: jest.fn().mockResolvedValue({ id: 'p1', source: 'platform', venueId: 'v1' }) },
      venue: { findUnique: jest.fn().mockResolvedValue({ id: 'v1', ownerId: 'owner-1' }) },
    };
    await expect(svc.ownerCancel(owner, 'p1', 'x')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'PLATFORM_BOOKING_LOCKED' }),
    });
  });
});

describe('phone numbers need customers.view', () => {
  it('hides the number from a staff account without it, keeps it for the owner', async () => {
    const prisma: any = {
      booking: { findUniqueOrThrow: jest.fn().mockResolvedValue(bookingRow({ guestPhone: '+201111111111' })) },
      staffMember: { findUnique: jest.fn() },
    };
    const svc = new OwnerBookingsService(prisma, {} as any, {} as any, {} as any);
    const staff: AuthenticatedUser = { id: 's1', phone: '', name: 'S', roles: ['staff'] };

    prisma.staffMember.findUnique.mockResolvedValue({ id: 'st', ownerId: 'owner-1', permissions: ['bookings.view'], venueIds: ['v1'], title: null });
    const hidden = await svc.toOwnerBookingDto({ id: 'b1' } as any, staff);
    expect(hidden.customer.phone).toBeUndefined();

    prisma.staffMember.findUnique.mockResolvedValue({ id: 'st', ownerId: 'owner-1', permissions: ['bookings.view', 'customers.view'], venueIds: ['v1'], title: null });
    expect((await svc.toOwnerBookingDto({ id: 'b1' } as any, staff)).customer.phone).toBe('+201111111111');
    expect((await svc.toOwnerBookingDto({ id: 'b1' } as any, owner)).customer.phone).toBe('+201111111111');
  });
});
