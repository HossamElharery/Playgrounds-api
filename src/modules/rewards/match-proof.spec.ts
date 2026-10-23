import { matchWasPlayedForReal, realPhotoUrls } from './match-proof';

describe('matchWasPlayedForReal', () => {
  const when = new Date('2026-10-20T18:00:00Z');
  const make = (found: unknown) => ({ booking: { findFirst: jest.fn(async () => found) } });

  it('needs a court: a post without one proves nothing', async () => {
    const prisma = make({ id: 'b' });
    expect(await matchWasPlayedForReal(prisma as any, { courtId: null, dateTime: when }, ['u1'])).toBe(false);
    expect(prisma.booking.findFirst).not.toHaveBeenCalled();
  });

  it('needs a booking checked in by venue staff, on that court, near that time, for one of the players', async () => {
    const prisma = make({ id: 'b' });
    expect(await matchWasPlayedForReal(prisma as any, { courtId: 'c1', dateTime: when }, ['u1', 'u2'])).toBe(true);
    const where = (prisma.booking.findFirst.mock.calls[0] as any[])[0].where;
    expect(where).toMatchObject({ courtId: 'c1', status: 'completed', source: 'platform', checkedInAt: { not: null }, userId: { in: ['u1', 'u2'] } });
    expect(where.slotStart.lte.getTime()).toBe(when.getTime() + 30 * 60_000);
    expect(where.slotEnd.gte.getTime()).toBe(when.getTime() - 30 * 60_000);
  });

  it('is false when there is no such booking', async () => {
    expect(await matchWasPlayedForReal(make(null) as any, { courtId: 'c1', dateTime: when }, ['u1'])).toBe(false);
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
