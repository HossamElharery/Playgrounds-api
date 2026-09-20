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
    payment: { create: jest.fn().mockResolvedValue({}) },
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
    const { prisma } = makePrisma();
    prisma.payment.aggregate.mockResolvedValue({ _sum: { amount: 400 } });
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
});
