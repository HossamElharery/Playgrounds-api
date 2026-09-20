import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { OwnerController } from '../owner/owner.controller';
import { assertVenueAccess } from '../../common/access/owner-access';
import { ApiException } from '../../common/errors/api-exception';
import { OwnerBookingsService } from '../owner/owner-bookings.service';
import { OwnerService } from '../owner/owner.service';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.interface';

const MUTATING = new Set([
  RequestMethod.POST,
  RequestMethod.PATCH,
  RequestMethod.PUT,
  RequestMethod.DELETE,
]);

/** Owner routes that are not venue writes (or are read-only POSTs). */
const WRITE_EXCEPTIONS = new Set([
  'assistant/interpret',
  'bookings/verify-qr',
  'staff-invites/:id/accept',
  'payout-methods',
  'payout-methods/:id',
]);

function ownerMutatingRoutes() {
  return Object.getOwnPropertyNames(OwnerController.prototype)
    .filter((key) => key !== 'constructor')
    .map((key) => {
      const fn = (OwnerController.prototype as unknown as Record<string, unknown>)[key] as object;
      return {
        key,
        method: Reflect.getMetadata(METHOD_METADATA, fn) as RequestMethod | undefined,
        path: (Reflect.getMetadata(PATH_METADATA, fn) as string | undefined) ?? key,
      };
    })
    .filter((r) => r.method !== undefined && MUTATING.has(r.method));
}

describe('owner mutating routes are admin-read-only', () => {
  const admin: AuthenticatedUser = {
    id: 'admin-1',
    phone: '',
    name: 'Admin',
    roles: ['admin'],
  };

  it('discovers mutating HTTP methods on OwnerController', () => {
    const routes = ownerMutatingRoutes();
    expect(routes.length).toBeGreaterThan(8);
    const venueWrites = routes.filter((r) => !WRITE_EXCEPTIONS.has(r.path));
    expect(venueWrites.map((r) => r.path)).toEqual(
      expect.arrayContaining([
        'bookings/manual',
        'bookings/:id',
        'calendar/blocks',
        'matchena-account/remittances',
      ]),
    );
  });

  it('admin write on a venue is ADMIN_READ_ONLY', async () => {
    const prisma = {
      venue: { findUnique: jest.fn().mockResolvedValue({ id: 'v1', ownerId: 'owner-1' }) },
    };
    try {
      await assertVenueAccess(prisma as never, admin, 'v1', { write: true });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiException);
      expect((err as ApiException).getResponse()).toEqual(
        expect.objectContaining({ code: 'ADMIN_READ_ONLY' }),
      );
    }
  });

  it('admin cannot create a manual booking or remittance', async () => {
    const prisma = {
      venue: { findUnique: jest.fn().mockResolvedValue({ id: 'v1', ownerId: 'owner-1', weeklyHours: null, priceFromCurrency: 'EGP' }) },
      court: { findUnique: jest.fn() },
      booking: { findUnique: jest.fn(), findUniqueOrThrow: jest.fn() },
      $transaction: jest.fn(),
    };
    const bookings = new OwnerBookingsService(
      prisma as never,
      { syncBookingLedger: jest.fn() } as never,
      { resolveSource: jest.fn() } as never,
      { create: jest.fn() } as never,
    );
    await expect(
      bookings.createManualBooking(admin, {
        venueId: 'v1',
        courtId: 'c1',
        startsAt: '2026-09-20T18:00:00.000Z',
        durationMinutes: 60,
        priceAmount: 400,
      }),
    ).rejects.toBeInstanceOf(ApiException);

    await expect(
      bookings.createRemittance(admin, { venueId: 'v1', amount: 100, method: 'cash' }),
    ).rejects.toBeInstanceOf(ApiException);
  });

  it('admin cannot create calendar blocks', async () => {
    const prisma = {
      venue: { findUnique: jest.fn().mockResolvedValue({ id: 'v1', ownerId: 'owner-1' }) },
    };
    const owner = new OwnerService(prisma as never, {} as never, { enabled: false } as never);
    await expect(
      owner.createCalendarBlock(admin, {
        venueId: 'v1',
        startsAt: '2026-09-20T18:00:00.000Z',
        endsAt: '2026-09-20T19:00:00.000Z',
        kind: 'maintenance',
      } as never),
    ).rejects.toBeInstanceOf(ApiException);
  });
});
