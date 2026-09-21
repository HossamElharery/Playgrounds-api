import { PlatformRequestsService } from './platform-requests.service';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.interface';

const owner: AuthenticatedUser = { id: 'o1', phone: '', name: 'O', roles: ['owner'] };
const stranger: AuthenticatedUser = { id: 'o2', phone: '', name: 'X', roles: ['owner'] };

function build(bookingStatus = 'confirmed') {
  const rows: any[] = [];
  const prisma: any = {
    venue: { findUnique: jest.fn(async () => ({ id: 'v1', ownerId: 'o1' })) },
    platformBookingRequest: {
      findFirst: jest.fn(async ({ where }: any) => rows.find((r) => r.bookingId === where.bookingId && r.kind === where.kind && r.status === where.status) ?? null),
      create: jest.fn(async ({ data }: any) => { const r = { id: `r${rows.length + 1}`, status: 'open', createdAt: new Date(), ...data }; rows.push(r); return r; }),
      findUnique: jest.fn(async ({ where }: any) => {
        const r = rows.find((x) => x.id === where.id);
        return r && { ...r, booking: { id: r.bookingId, code: 'MC-1', slotStart: new Date(), slotEnd: new Date(), status: bookingStatus, baseAmount: 100, court: { name: 'C1' } }, venue: { id: 'v1', nameEn: 'V', nameAr: 'م', ownerId: 'o1' } };
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const r = rows.find((x) => x.id === where.id && x.status === where.status);
        if (!r) return { count: 0 };
        Object.assign(r, data);
        return { count: 1 };
      }),
    },
    auditLogEntry: { create: jest.fn(async () => ({})) },
  };
  const notifications: any = { create: jest.fn(async () => ({})) };
  const bookings: any = { cancelByAdmin: jest.fn(async () => ({})) };
  return { svc: new PlatformRequestsService(prisma, notifications, bookings), rows, notifications, bookings, prisma };
}

describe('PlatformRequestsService', () => {
  it('records one open request per booking and kind (a second ask is a duplicate)', async () => {
    const { svc, rows } = build();
    const a = await svc.record({ bookingId: 'b1', venueId: 'v1', kind: 'cancel', reason: 'pitch flooded', userId: 'o1' });
    const b = await svc.record({ bookingId: 'b1', venueId: 'v1', kind: 'cancel', reason: 'again', userId: 'o1' });
    expect(a.duplicate).toBe(false);
    expect(b).toEqual({ id: a.id, duplicate: true });
    expect(rows).toHaveLength(1);
  });

  it('approving a cancellation cancels the booking exactly once and tells the owner', async () => {
    const { svc, bookings, notifications, rows } = build();
    const { id } = await svc.record({ bookingId: 'b1', venueId: 'v1', kind: 'cancel', reason: 'flooded pitch', userId: 'o1' });
    await svc.approveCancel('admin-1', id, 'Refunded the player');
    expect(bookings.cancelByAdmin).toHaveBeenCalledTimes(1);
    expect(bookings.cancelByAdmin).toHaveBeenCalledWith('admin-1', 'b1', 'Refunded the player');
    expect(rows[0]).toMatchObject({ status: 'approved', resolvedById: 'admin-1', adminReply: 'Refunded the player' });
    expect(notifications.create).toHaveBeenCalledWith(expect.objectContaining({ userId: 'o1' }));
    // a second click never refunds again
    await expect(svc.approveCancel('admin-2', id)).rejects.toMatchObject({ response: expect.objectContaining({ code: 'REQUEST_ALREADY_RESOLVED' }) });
    expect(bookings.cancelByAdmin).toHaveBeenCalledTimes(1);
  });

  it('an already-cancelled booking is not cancelled again, but the request still closes', async () => {
    const { svc, bookings } = build('cancelled');
    const { id } = await svc.record({ bookingId: 'b1', venueId: 'v1', kind: 'cancel', reason: 'player cancelled', userId: 'o1' });
    await svc.approveCancel('admin-1', id);
    expect(bookings.cancelByAdmin).not.toHaveBeenCalled();
  });

  it('a change request cannot be "approved" as a cancellation; declining and answering need words', async () => {
    const { svc, bookings } = build();
    const { id } = await svc.record({ bookingId: 'b1', venueId: 'v1', kind: 'change', reason: 'move an hour', userId: 'o1' });
    await expect(svc.approveCancel('a', id)).rejects.toBeDefined();
    await expect(svc.decline('a', id, '  ')).rejects.toBeDefined();
    await expect(svc.answer('a', id, '')).rejects.toBeDefined();
    await svc.answer('a', id, 'We asked the player to move');
    expect(bookings.cancelByAdmin).not.toHaveBeenCalled();
  });

  it("another venue's owner cannot list a venue's requests", async () => {
    const { svc } = build();
    await expect(svc.listForVenue(stranger, 'v1')).rejects.toBeDefined();
  });
});
