import { matchWasPlayedForReal, realPhotoUrls } from './match-proof';

describe('matchWasPlayedForReal', () => {
  const when = new Date('2026-10-20T18:00:00Z');
  const make = (found: { id: string }[], okIds: string[] = found.map((f) => f.id)) => ({
    prisma: { booking: { findMany: jest.fn(async () => found) } },
    qualification: { assess: jest.fn(async (id: string) => (okIds.includes(id) ? { ok: true } : { ok: false, reason: 'venue_insider' })) },
  });

  it('needs a court: a post without one proves nothing', async () => {
    const { prisma, qualification } = make([{ id: 'b' }]);
    expect(await matchWasPlayedForReal(prisma as any, qualification as any, { courtId: null, dateTime: when }, ['u1'])).toBe(false);
    expect(prisma.booking.findMany).not.toHaveBeenCalled();
  });

  it('looks for checked-in platform bookings on that court near that time for one of the players', async () => {
    const { prisma, qualification } = make([{ id: 'b' }]);
    expect(await matchWasPlayedForReal(prisma as any, qualification as any, { courtId: 'c1', dateTime: when }, ['u1', 'u2'])).toBe(true);
    const where = (prisma.booking.findMany.mock.calls[0] as any[])[0].where;
    expect(where).toMatchObject({ courtId: 'c1', status: 'completed', source: 'platform', checkedInAt: { not: null }, userId: { in: ['u1', 'u2'] } });
    expect(where.slotStart.lte.getTime()).toBe(when.getTime() + 30 * 60_000);
    expect(where.slotEnd.gte.getTime()).toBe(when.getTime() - 30 * 60_000);
  });

  it('a booking that fails the rewards test (venue insider, last minute...) is not a proof', async () => {
    const { prisma, qualification } = make([{ id: 'b1' }, { id: 'b2' }], []);
    expect(await matchWasPlayedForReal(prisma as any, qualification as any, { courtId: 'c1', dateTime: when }, ['u1'])).toBe(false);
    expect(qualification.assess).toHaveBeenCalledTimes(2);
  });

  it('one qualifying booking among several is enough', async () => {
    const { prisma, qualification } = make([{ id: 'b1' }, { id: 'b2' }], ['b2']);
    expect(await matchWasPlayedForReal(prisma as any, qualification as any, { courtId: 'c1', dateTime: when }, ['u1'])).toBe(true);
  });

  it('is false when there is no booking at all', async () => {
    const { prisma, qualification } = make([]);
    expect(await matchWasPlayedForReal(prisma as any, qualification as any, { courtId: 'c1', dateTime: when }, ['u1'])).toBe(false);
  });
});

describe('realPhotoUrls', () => {
  it('keeps real upload URLs and drops junk, so a made-up string earns no photo bonus', () => {
    expect(realPhotoUrls(['https://cdn.matchena.com/a.jpg', '/uploads/b.jpg', 'x', '', 'javascript:alert(1)', 'http://insecure/c.jpg'])).toEqual([
      'https://cdn.matchena.com/a.jpg',
      '/uploads/b.jpg',
    ]);
    expect(realPhotoUrls(undefined)).toEqual([]);
  });
});
