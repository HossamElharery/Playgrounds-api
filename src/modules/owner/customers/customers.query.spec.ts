import { queryCustomers } from './customers.query';
import { PrismaService } from '../../prisma/prisma.service';

describe('customer directory identity', () => {
  it('keeps the first contact name when later bookings share that phone', async () => {
    const findMany = jest.fn().mockResolvedValue([{guestPhone:'+201012345678',guestName:'Hossam'}]);
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([{key:'m:+201012345678',bookings:2,spent:0,owed:0,noShows:0,lastVisit:null,firstVisit:null}]),
      user:{findMany:jest.fn()}, booking:{groupBy:jest.fn().mockResolvedValue([]),findMany},
      venueCustomer:{findMany:jest.fn().mockResolvedValue([])},
    };
    const items = await queryCustomers(prisma as unknown as PrismaService,'v1','owner');
    expect(items[0].name).toBe('Hossam');
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where:expect.objectContaining({venueId:'v1'}),
      orderBy:[{createdAt:'asc'},{id:'asc'}], distinct:['guestPhone'],
    }));
    expect(findMany.mock.calls[0][0].take).toBeUndefined();
  });

  it('a booking for later is not a visit: visits and the last visit count only games that happened', async () => {
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([{ key: 'm:+201012345678', bookings: 3, visits: 1, nextBooking: new Date('2030-01-01T17:00:00Z'), spent: 0, owed: 0, noShows: 0, lastVisit: new Date('2026-09-01T17:00:00Z'), firstVisit: new Date('2026-09-01T17:00:00Z') }]),
      user: { findMany: jest.fn() }, booking: { groupBy: jest.fn().mockResolvedValue([]), findMany: jest.fn().mockResolvedValue([]) },
      venueCustomer: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const [c] = await queryCustomers(prisma as unknown as PrismaService, 'v1', 'owner');
    expect(c).toMatchObject({ bookings: 3, visits: 1 });
    expect(c.nextBooking?.toISOString()).toBe('2030-01-01T17:00:00.000Z');
    expect(c.lastVisit?.toISOString()).toBe('2026-09-01T17:00:00.000Z');
    const sql = JSON.stringify(prisma.$queryRaw.mock.calls[0][0]);
    // The query itself must separate the past from the future, not just the mapper.
    expect(sql).toContain('FILTER');
    expect(sql).toContain('nextBooking');
  });

  it('someone imported but not yet booked has no visits and no next booking', async () => {
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      user: { findMany: jest.fn().mockResolvedValue([]) }, booking: { groupBy: jest.fn().mockResolvedValue([]), findMany: jest.fn().mockResolvedValue([]) },
      venueCustomer: { findMany: jest.fn().mockResolvedValue([{ key: 'm:+20101', name: 'Imported', phone: '+20101', note: null, imported: true }]) },
    };
    const [c] = await queryCustomers(prisma as unknown as PrismaService, 'v1', 'owner');
    expect(c).toMatchObject({ visits: 0, nextBooking: null, bookings: 0 });
  });
});
