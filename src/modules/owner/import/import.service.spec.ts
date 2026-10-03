import { ImportService } from './import.service';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.interface';

const staff: AuthenticatedUser = { id: 'staff', name: 'Booker', phone: '+2010', roles: ['staff'] };

describe('ImportService secondary permissions', () => {
  function setup(permissions: string[], paidAmount: number) {
    const prisma: any = {
      staffMember: { findUnique: jest.fn(async () => ({ id: 'member', ownerId: 'owner', venueIds: ['venue'], permissions })) },
      venueImportBatch: { create: jest.fn() },
    };
    const service = new ImportService(prisma, {} as any);
    jest.spyOn(service as any, 'analyse').mockResolvedValue({
      config: { kind: 'bookings', venueId: 'venue' },
      rows: [{ row: 2, status: 'ok' }],
      bookingsByRow: new Map([[2, { paidAmount }]]),
    });
    return { service, prisma };
  }

  it('rejects paid imported bookings before persisting a batch for booking-only staff', async () => {
    const { service, prisma } = setup(['bookings.create'], 10000);
    await expect(service.commit(staff, undefined, {})).rejects.toMatchObject({ status: 403 });
    expect(prisma.venueImportBatch.create).not.toHaveBeenCalled();
  });

  it('rejects even unpaid imported bookings without booking creation permission', async () => {
    const { service, prisma } = setup(['venue.manage', 'payments.record'], 0);
    await expect(service.commit(staff, undefined, {})).rejects.toMatchObject({ status: 403 });
    expect(prisma.venueImportBatch.create).not.toHaveBeenCalled();
  });
});
